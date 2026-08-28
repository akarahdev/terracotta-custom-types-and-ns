import { RootNode } from "../src/ast/astNode.ts";
import { Lexer } from "../src/parser/lexer.ts";
import { Parser } from "../src/parser/parser.ts";
import { CodeCompiler } from "../src/compiler/codeCompiler.ts";
import { ActionBlock } from "../src/compiler/codeBlock.ts";
import { VariableValue } from "../src/compiler/codeValue.ts";
import { DFCodeblockName, DFRank } from "../src/df/constants.ts";
import { TCError } from "../src/error/error.ts";
import {
  getExtensionFunctionBackendName,
  TypeProcessor,
} from "../src/typeProcessor/typeProcessor.ts";
import {
  getSourceNamespaceDictionaryBackendName,
  getSourceNamespaceMemberBackendName,
} from "../src/compiler/namespace/sourceNamespace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function compileScripts(
  scripts: string[],
  optimizationsEnabled: boolean = false,
) {
  const roots: RootNode[] = [];
  const parseErrors: TCError[] = [];
  for (let index = 0; index < scripts.length; index++) {
    const lexer = new Lexer();
    lexer.tokenize(scripts[index], `namespace-${index}.tc`);
    const parser = new Parser(lexer.tokens);
    const root = parser.parse();
    root.scriptContents = scripts[index];
    root.filePath = `namespace-${index}.tc`;
    roots.push(root);
    parseErrors.push(...lexer.errors, ...parser.errors);
  }

  const types = new TypeProcessor();
  types.collectionStage(roots);
  types.evaluationStage();
  const compiler = new CodeCompiler(roots.flatMap((root) => root.statements), {
    types,
    rank: DFRank.OVERLORD,
    getItemLibraries: () => ({}),
    optimizationsEnabled,
  });
  compiler.compile({ outputFormat: "GZIP" });
  return {
    types,
    compiler,
    errors: [...parseErrors, ...types.errors, ...compiler.errors],
  };
}

Deno.test("source namespaces merge across files and use extension-family mangling", () => {
  const result = compileScripts([
    `
            namespace physics {
                gravity: num = -9.8;
                function apply_gravity() {
                    gravity += 1;
                }
            }
        `,
    `
            namespace physics.collisions {
                function resolve() {}
            }

            namespace physics {
                namespace collisions.broadphase {
                    function scan() {}
                }
            }

            import physics;
            playerevent join {
                physics.apply_gravity();
                physics.collisions.resolve();
                physics.collisions.broadphase.scan();
                physics.gravity = -8;
            }
        `,
  ]);

  assert(
    result.errors.length == 0,
    result.errors.map((error) => error.message).join("\n"),
  );
  const functions = result.compiler.codeLines.get(DFCodeblockName.FUNCTION)!;
  assert(
    getSourceNamespaceMemberBackendName(["physics"], "apply_gravity") in
      functions,
    "missing mangled namespace function",
  );
  assert(
    getSourceNamespaceMemberBackendName(["physics", "collisions"], "resolve") in
      functions,
    "missing nested mangled namespace function",
  );
  assert(
    getSourceNamespaceMemberBackendName(
      ["physics", "collisions", "broadphase"],
      "scan",
    ) in functions,
    "missing relative dotted namespace function",
  );

  const startup =
    result.compiler.codeLines.get(DFCodeblockName.GAME_EVENT)!.PlotStartup;
  const initializer = startup.code.flat().find((block) => (
    block instanceof ActionBlock &&
    block.action == "=" &&
    block.args[0] instanceof VariableValue &&
    block.args[0].name ==
      getSourceNamespaceMemberBackendName(["physics"], "gravity")
  ));
  assert(
    initializer != undefined,
    "namespace variable was not initialized at PlotStartup",
  );
  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceMemberBackendName(["physics"], "gravity")
    )),
    "static writes should work through compile-time-only namespaces",
  );
});

Deno.test("namespace mangling is injective and cannot overlap extension-method names", () => {
  const memberName = getSourceNamespaceMemberBackendName(["physics"], "foo");
  assert(
    memberName != getExtensionFunctionBackendName("NS_7_physics_3", "foo"),
    "namespace names must not collide with extension backend names",
  );
  assert(
    getSourceNamespaceMemberBackendName(["a_b", "c"], "value") !=
      getSourceNamespaceMemberBackendName(["a", "b_c"], "value"),
    "distinct dotted paths must remain distinct after mangling",
  );
  assert(
    !memberName.substring("__TC_EXT_".length).includes("_"),
    "namespace suffixes must remain disjoint from extension separators",
  );
});

Deno.test("namespace member imports and nearest namespace scope resolve statically", () => {
  const result = compileScripts([
    `
            namespace outer {
                value: num = 1;
                namespace inner {
                    value: num = 2;
                    function current() {
                        value += 1;
                    }
                }
            }
        `,
    `
            import outer.inner.current;
            import outer as exported_outer;
            playerevent join {
                current();
                exported_outer.inner.current();
            }
        `,
  ]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  assert(
    result.types.errors.some((error) =>
      error.isWarning && error.message.includes("shadows ancestor")
    ),
    "expected namespace shadowing warning",
  );
});

Deno.test("schema namespaces emit immediate dictionaries and support reflection", () => {
  const result = compileScripts([`
        namespace numbers {
            schema: num;
            one: 1;
            two: 2;
        }

        import numbers;
        playerevent join {
            line key = "one";
            line value = numbers[key];
            line keys = namespace.getKeys(numbers);
            line values = namespace.getValues(numbers);
            numbers.one = 3;
            numbers[key] = 4;
            if (namespace.has_member(numbers, key)) {}
            for (line entryKey, line entryValue of numbers) {}
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  const startup =
    result.compiler.codeLines.get(DFCodeblockName.GAME_EVENT)!.PlotStartup;
  assert(
    startup.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "CreateDict" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name == getSourceNamespaceDictionaryBackendName(["numbers"])
    )),
    "missing schema namespace dictionary initialization",
  );
  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  assert(
    join.code.flat().some((block) =>
      block instanceof ActionBlock && block.action == "GetDictKeys"
    ),
    "missing namespace.getKeys lowering",
  );
  assert(
    join.code.flat().some((block) =>
      block instanceof ActionBlock && block.action == "GetDictValues"
    ),
    "missing namespace.getValues lowering",
  );
  assert(
    join.code.flat().some((block) =>
      block instanceof ActionBlock && block.action == "DictHasKey"
    ),
    "missing namespace.has_member lowering",
  );
  assert(
    join.code.flat().some((block) =>
      block instanceof ActionBlock && block.action == "SetDictValue"
    ),
    "qualified schema writes should update the runtime dictionary",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.IF_VARIABLE &&
      block.action == "="
    )),
    "computed namespace writes should synchronize known mangled members",
  );
  assert(
    join.code.flat().some((block) =>
      block instanceof ActionBlock && block.action == "ForEachEntry"
    ),
    "schema namespace should be iterable as a dictionary",
  );
});

Deno.test("unschemed namespaces reject reflection and dynamic indexing", () => {
  const result = compileScripts([`
        namespace static_api {
            value: num = 1;
        }

        import static_api;
        playerevent join {
            line key = "value";
            line dynamic = static_api[key];
            line keys = namespace.getKeys(static_api);
        }
    `]);

  const messages = result.errors.filter((error) => !error.isWarning).map(
    (error) => error.message,
  );
  assert(
    messages.some((message) =>
      message.includes("Member access not allowed on type 'namespace'")
    ),
    "unschemed namespaces must reject dynamic indexing",
  );
  assert(
    messages.some((message) =>
      message.includes(
        "Namespace reflection requires a schema-backed namespace value",
      )
    ),
    "unschemed namespaces must reject reflection",
  );
});

Deno.test("schema dictionaries exist before namespace variable initializers use dynamic calls", () => {
  const result = compileScripts([`
        namespace providers {
            schema: function() -> num;
            function answer(): num {
                return 42;
            }
        }

        import providers;
        namespace state {
            answer: num = providers["answer"]();
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  const startupCode = result.compiler.codeLines.get(DFCodeblockName.GAME_EVENT)!
    .PlotStartup.code.flat();
  const dictionaryIndex = startupCode.findIndex((block) => (
    block instanceof ActionBlock &&
    block.action == "CreateDict" &&
    block.args[0] instanceof VariableValue &&
    block.args[0].name == getSourceNamespaceDictionaryBackendName(["providers"])
  ));
  const callIndex = startupCode.findIndex((block) => (
    block instanceof ActionBlock &&
    block.block == DFCodeblockName.CALL_FUNCTION &&
    block.action.startsWith("%var(@__TC_TMP_")
  ));
  assert(
    dictionaryIndex >= 0,
    "missing function-schema dictionary initialization",
  );
  assert(
    callIndex > dictionaryIndex,
    "dynamic namespace calls in initializers must run after dictionary setup",
  );
});

Deno.test("namespace output survives the production optimizer", () => {
  const result = compileScripts([`
        namespace handlers {
            schema: function(message: txt) -> void;
            function immediate(message: txt) {}
            process deferred(message: txt) {}
        }

        import handlers;
        playerevent join {
            line key = "immediate";
            handlers[key](s"hello");
            key = "deferred";
            start handlers[key](s"hello");
        }
    `], true);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
});

Deno.test("namespace shape defaults and dynamic function dispatch compile through dictionaries", () => {
  const result = compileScripts([`
        namespace render_config {
            schema: namespace {
                color?: num;
                scale: num = 1;
            };
        }

        namespace entity_type {
            schema: namespace {
                name: txt;
                hardness: num;
                render?: namespace render_config;
                function on_spawn(pos: loc) -> void;
            };
        }

        namespace entity_type.zombie {
            name: txt = s"Zombie";
            hardness: num = 5;
            namespace render {
                color: num = 5;
            }
            function on_spawn(pos: loc) {}
        }

        namespace handlers {
            schema: function(message: txt) -> void;
            function greet(message: txt) {}
        }

        import entity_type;
        import handlers;
        playerevent join {
            line id = "zombie";
            line position: loc;
            entity_type[id].on_spawn(position);
            handlers[id](s"hello");
            line scale = entity_type[id].render.scale;
            line childKeys = namespace.getKeys(entity_type[id]);
            for (line childKey, line childValue of entity_type[id]) {}
            entity_type[id].hardness = 6;
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.CALL_FUNCTION &&
      block.action.startsWith("%var(@__TC_TMP_")
    )),
    "missing dynamic namespace Call Function lowering",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "GetDictKeys"
    )),
    "dynamic schema children should support namespace reflection",
  );
  const startup =
    result.compiler.codeLines.get(DFCodeblockName.GAME_EVENT)!.PlotStartup;
  const dictionaryTargets = startup.code.flat()
    .filter((block): block is ActionBlock =>
      block instanceof ActionBlock && block.action == "CreateDict"
    )
    .map((block) => block.args[0])
    .filter((value): value is VariableValue => value instanceof VariableValue)
    .map((value) => value.name);
  assert(
    dictionaryTargets.includes(
      getSourceNamespaceDictionaryBackendName(["entity_type", "zombie"]),
    ),
    "missing conforming namespace dictionary",
  );
  assert(
    dictionaryTargets.includes(
      getSourceNamespaceDictionaryBackendName(["handlers"]),
    ),
    "missing function schema dictionary",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceDictionaryBackendName(["entity_type", "zombie"])
    )),
    "dynamic nested writes should synchronize the matching child dictionary",
  );
});

Deno.test("homogeneous process schemas require start and dispatch through Start Process", () => {
  const result = compileScripts([`
        namespace workers {
            schema: function(job: str) -> void;
            process run(job: str) {}
        }

        import workers;
        playerevent join {
            line selected = "run";
            start workers[selected]("job");
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  assert(
    getSourceNamespaceMemberBackendName(["workers"], "run") in
      result.compiler.codeLines.get(DFCodeblockName.PROCESS)!,
    "missing mangled namespace process",
  );
  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.START_PROCESS &&
      block.action.startsWith("%var(@__TC_TMP_")
    )),
    "missing dynamic namespace Start Process lowering",
  );
});

Deno.test("mixed function/process schemas dispatch according to call syntax", () => {
  const result = compileScripts([`
        namespace handlers {
            schema: function(message: txt) -> void;
            function immediate(message: txt) {}
            process deferred(message: txt) {}
        }

        import handlers;
        playerevent join {
            line selected = "deferred";
            handlers[selected](s"hello");
            start handlers[selected](s"hello");
            handlers.immediate(s"hello");
            start handlers.deferred(s"hello");
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  const processName = getSourceNamespaceMemberBackendName(
    ["handlers"],
    "deferred",
  );
  const functionName = getSourceNamespaceMemberBackendName(
    ["handlers"],
    "immediate",
  );
  const functions = result.compiler.codeLines.get(DFCodeblockName.FUNCTION)!;
  assert(functionName in functions, "missing mixed-schema function");
  assert(
    processName in result.compiler.codeLines.get(DFCodeblockName.PROCESS)!,
    "missing mixed-schema process",
  );
  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.CALL_FUNCTION &&
      block.action.startsWith("%var(@__TC_TMP_")
    )),
    "ordinary mixed-schema calls should dynamically Call Function",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.START_PROCESS &&
      block.action.startsWith("%var(@__TC_TMP_")
    )),
    "start mixed-schema calls should dynamically Start Process",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.CALL_FUNCTION &&
      block.action == functionName
    )),
    "static function members should call their mangled function",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.START_PROCESS &&
      block.action == processName
    )),
    "static process members should start their mangled process",
  );
});

Deno.test("namespace function/process names and invocation syntax cannot conflict", () => {
  const result = compileScripts([`
        namespace entries {
            schema: function(message: txt) -> void;
            function immediate(message: txt) {}
            process deferred(message: txt) {}
        }

        namespace invalid {
            function same() {}
            process same() {}
        }

        import entries;
        playerevent join {
            entries.deferred(s"hello");
            start entries.immediate(s"hello");
        }
    `]);

  const messages = result.errors.filter((error) => !error.isWarning).map(
    (error) => error.message,
  );
  assert(
    messages.some((message) =>
      message.includes("Processes must be invoked with 'start'")
    ),
    "ordinary calls must reject static namespace processes",
  );
  assert(
    messages.some((message) =>
      message.includes("function; call it without 'start'")
    ),
    "start must reject static namespace functions",
  );
  assert(
    messages.some((message) =>
      message.includes("invalid.same") &&
      message.includes("declared in multiple places")
    ),
    "a function and process cannot share a namespace member name",
  );
});

Deno.test("namespace defaults materialize nested namespaces before imports resolve", () => {
  const result = compileScripts([
    `
        namespace render_config {
            schema: namespace {
                scale: num = 1;
            };
        }

        namespace entities {
            schema: namespace {
                render: namespace render_config = {};
            };
        }

        namespace entities.box {}
    `,
    `
        import entities.box.render;
        playerevent join {
            line scale = render.scale;
        }
    `,
  ]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  const startup =
    result.compiler.codeLines.get(DFCodeblockName.GAME_EVENT)!.PlotStartup;
  assert(
    startup.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "CreateDict" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceDictionaryBackendName(["entities", "box", "render"])
    )),
    "missing dictionary for generated default namespace",
  );
});

Deno.test("optional shape fields remain absent from statically known conformers", () => {
  const result = compileScripts([`
        namespace config {
            schema: namespace {
                enabled?: num;
                scale: num = 1;
            };
        }

        namespace config.minimal {}

        import config;
        playerevent join {
            line missing = config.minimal.enabled;
        }
    `]);

  const messages = result.errors.filter((error) => !error.isWarning).map(
    (error) => error.message,
  );
  assert(
    messages.some((message) => message.includes("'enabled' is not a property")),
    "optional fields without defaults must not become statically accessible",
  );
});

Deno.test("namespace validation rejects incompatible declarations without leaking members globally", () => {
  const result = compileScripts([`
        namespace private_api {
            function hidden() {}
        }

        namespace bad_values {
            schema: num;
            value: "not a number";
        }

        namespace duplicate_schema {
            schema: num;
        }
        namespace duplicate_schema {
            schema: str;
        }

        playerevent join {
            hidden();
        }
    `]);

  const messages = result.errors.filter((error) => !error.isWarning).map(
    (error) => error.message,
  );
  assert(
    messages.some((message) =>
      message.includes("bad_values.value") && message.includes("expected 'num'")
    ),
    "value-schema mismatch should be diagnosed",
  );
  assert(
    messages.some((message) =>
      message.includes("duplicate_schema") &&
      message.includes("more than one schema")
    ),
    "duplicate schemas should be diagnosed",
  );
  assert(
    messages.some((message) =>
      message.includes("Could not resolve identifier 'hidden'")
    ),
    "namespace members must not leak into the global function scope",
  );
});

Deno.test("unqualified namespace-variable writes keep schema dictionaries synchronized", () => {
  const result = compileScripts([`
        namespace counters {
            schema: namespace {
                count: num;
                function bump() -> void;
            };
        }

        namespace counters.one {
            count: num = 0;
            function bump() {
                count += 1;
            }
        }

        import counters;
        playerevent join {
            counters.one.bump();
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  const bump = result.compiler.codeLines.get(
    DFCodeblockName.FUNCTION,
  )![getSourceNamespaceMemberBackendName(["counters", "one"], "bump")];
  assert(
    bump.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "SetDictValue" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceDictionaryBackendName(["counters", "one"])
    )),
    "unqualified namespace variable write did not update the child dictionary",
  );
});

Deno.test("partial nested defaults and chained dynamic namespace access preserve immediate dictionaries", () => {
  const result = compileScripts([`
        namespace render_config {
            schema: namespace {
                color: num = 1;
                scale: num = 2;
            };
        }

        namespace entity_type {
            schema: namespace {
                render: namespace render_config = { color: 3 };
            };
        }

        namespace entity_type.zombie {}

        namespace outer {
            base: num = 1;
            namespace inner {
                function bump() {
                    base += 1;
                }
            }
        }

        import entity_type;
        import outer.inner.bump;
        playerevent join {
            line type_id = "zombie";
            line member = "render";
            entity_type[type_id][member]["scale"] = 5;
            line scale = entity_type[type_id][member].scale;
            bump();
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );

  const renderPath = ["entity_type", "zombie", "render"];
  const startup =
    result.compiler.codeLines.get(DFCodeblockName.GAME_EVENT)!.PlotStartup;
  assert(
    startup.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "CreateDict" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name == getSourceNamespaceDictionaryBackendName(renderPath)
    )),
    "partial default did not materialize its nested namespace dictionary",
  );
  assert(
    startup.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceMemberBackendName(renderPath, "scale")
    )),
    "omitted nested field did not receive its target-schema default",
  );

  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  assert(
    join.code.flat().filter((block) =>
      block instanceof ActionBlock && block.action == "GetDictValue"
    ).length >= 3,
    "chained dynamic namespace access did not emit sequential dictionary reads",
  );

  const bump = result.compiler.codeLines.get(DFCodeblockName.FUNCTION)![
    getSourceNamespaceMemberBackendName(["outer", "inner"], "bump")
  ];
  assert(
    bump.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.args.some((argument) => (
        argument instanceof VariableValue &&
        argument.name == getSourceNamespaceMemberBackendName(["outer"], "base")
      ))
    )),
    "nested namespace function did not resolve its ancestor member unqualified",
  );
});
