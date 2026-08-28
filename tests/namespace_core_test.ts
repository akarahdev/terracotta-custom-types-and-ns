import { RootNode } from "../src/ast/astNode.ts";
import { Lexer } from "../src/parser/lexer.ts";
import { Parser } from "../src/parser/parser.ts";
import { CodeCompiler } from "../src/compiler/codeCompiler.ts";
import { ActionBlock } from "../src/compiler/codeBlock.ts";
import { StringValue, VariableValue } from "../src/compiler/codeValue.ts";
import { DFCodeblockName, DFRank } from "../src/df/constants.ts";
import { TCError } from "../src/error/error.ts";
import {
  getExtensionFunctionBackendName,
  TypeProcessor,
} from "../src/typeProcessor/typeProcessor.ts";
import {
  getSourceNamespaceKeyListBackendName,
  getSourceNamespaceMemberBackendName,
} from "../src/compiler/namespace/sourceNamespace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function renderedVariableName(value: VariableValue): string {
  return typeof value.name == "string" ? value.name : value.name.join("");
}

function isDynamicSourceNamespaceReference(
  value: unknown,
): value is VariableValue {
  return value instanceof VariableValue &&
    renderedVariableName(value).startsWith("__TC_EXT_NS@") &&
    renderedVariableName(value).includes("%var(");
}

function isSourceNamespaceKeyList(value: unknown): value is VariableValue {
  return value instanceof VariableValue &&
    renderedVariableName(value).startsWith("__TC_EXT_NK@");
}

function isDictionaryAction(block: unknown): boolean {
  return block instanceof ActionBlock && [
    "CreateDict",
    "GetDictValue",
    "SetDictValue",
    "GetDictKeys",
    "DictHasKey",
  ].includes(block.action);
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
    memberName == "__TC_EXT_NS@physics@foo",
    "namespace member mangling should use the readable literal path pattern",
  );
  assert(
    getSourceNamespaceKeyListBackendName(["physics"]) == "__TC_EXT_NK@physics",
    "namespace reflection key lists should use the same readable path pattern",
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

Deno.test("schema namespaces emit key lists and direct source-path access", () => {
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
            for (line entryKey, line entryValue of numbers) {
                line incremented = entryValue + 1;
            }
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
      block.action == "CreateList" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name == getSourceNamespaceKeyListBackendName(["numbers"])
    )),
    "missing schema namespace key-list initialization",
  );
  assert(
    startup.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "CreateList" &&
      block.args.some((argument) => (
        argument instanceof StringValue &&
        argument.value == "one"
      ))
    )),
    "schema key lists should contain member names rather than copied values",
  );
  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some(isSourceNamespaceKeyList)
    )),
    "namespace.getKeys should copy the namespace key list",
  );
  assert(
    join.code.flat().some((block) =>
      block instanceof ActionBlock && block.action == "AppendValue"
    ),
    "namespace.getValues should build a dereferenced values list",
  );
  assert(
    join.code.flat().some((block) =>
      block instanceof ActionBlock && block.action == "ListContains"
    ),
    "missing namespace.has_member lowering",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some(isDynamicSourceNamespaceReference)
    )),
    "computed namespace reads and writes should compose source paths directly",
  );
  const dynamicReferences = join.code.flat().flatMap((block) =>
    block instanceof ActionBlock ? block.args : []
  ).filter(isDynamicSourceNamespaceReference);
  assert(
    dynamicReferences.every((reference) =>
      reference.templateForm().data.name == renderedVariableName(reference)
    ),
    "dynamic source-path variables must serialize their PCode names",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "ForEach" &&
      block.args.some(isSourceNamespaceKeyList)
    )),
    "schema namespace should iterate its key list",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args[0] instanceof VariableValue &&
      renderedVariableName(block.args[0]) == "entryValue" &&
      isDynamicSourceNamespaceReference(block.args[1])
    )),
    "namespace iteration should resolve each value through its source path",
  );
  assert(
    !join.code.flat().some(isDictionaryAction),
    "namespace lowering must not emit dictionary actions",
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

Deno.test("namespace declarations are rejected from runtime code", () => {
  const result = compileScripts([`
        playerevent join {
            namespace invalid {
                value: num = 1;
            }
        }
    `]);

  const messages = result.errors.filter((error) => !error.isWarning).map(
    (error) => error.message,
  );
  assert(
    messages.some((message) =>
      message.includes(
        "Namespace declarations can only appear at the top level",
      )
    ),
    "namespace declarations inside runtime code must not be silently ignored",
  );
});

Deno.test("schema key lists exist before namespace variable initializers", () => {
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
  const keyListIndex = startupCode.findIndex((block) => (
    block instanceof ActionBlock &&
    block.action == "CreateList" &&
    block.args[0] instanceof VariableValue &&
    block.args[0].name == getSourceNamespaceKeyListBackendName(["providers"])
  ));
  const callIndex = startupCode.findIndex((block) => (
    block instanceof ActionBlock &&
    block.block == DFCodeblockName.CALL_FUNCTION &&
    block.action == getSourceNamespaceMemberBackendName(["providers"], "answer")
  ));
  assert(
    keyListIndex >= 0,
    "missing function-schema key-list initialization",
  );
  assert(
    callIndex > keyListIndex,
    "namespace initializers must run after key-list setup",
  );
});

Deno.test("namespace output survives the production optimizer", () => {
  const result = compileScripts([`
        namespace handlers {
            schema: function(message: txt) -> void;
            function immediate(message: txt) {}
            process deferred(message: txt) {}
        }

        namespace counters {
            schema: num;
            current: 1;
        }

        import handlers;
        import counters;
        playerevent join {
            line key = "immediate";
            handlers[key](s"hello");
            key = "deferred";
            start handlers[key](s"hello");
            line counterKey = "current";
            line counter = counters[counterKey];
            counters[counterKey] = counter + 1;
        }
    `], true);

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
      block.action == "=" &&
      block.args.some(isDynamicSourceNamespaceReference)
    )),
    "optimizer must preserve dynamic source-path references",
  );
});

Deno.test("mixed namespace shapes retain direct values and function selectors", () => {
  const result = compileScripts([`
        namespace entity_type {
            schema: namespace {
                hardness: num;
                function on_spawn() -> void;
            };
        }

        namespace entity_type.zombie {
            hardness: num = 5;
            function on_spawn() {}
        }

        import entity_type;
        playerevent join {
            line id = "zombie";
            line values = namespace.getValues(entity_type[id]);
            for (line key, line value of entity_type[id]) {}
            entity_type[id].hardness = 6;
            entity_type[id].on_spawn();
        }
    `], true);

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
      block.action == "CreateList" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceKeyListBackendName(["entity_type"]) &&
      block.args.some((argument) => (
        argument instanceof StringValue &&
        argument.value == "zombie"
      ))
    )),
    "parent key list should store child member names",
  );
  assert(
    startup.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "CreateList" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceKeyListBackendName(["entity_type", "zombie"]) &&
      block.args.some((argument) => (
        argument instanceof StringValue &&
        argument.value == "hardness"
      ))
    )),
    "shape key list should include value fields",
  );
  assert(
    startup.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "CreateList" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceKeyListBackendName(["entity_type", "zombie"]) &&
      block.args.some((argument) => (
        argument instanceof StringValue &&
        argument.value == "on_spawn"
      ))
    )),
    "shape key list should include function fields",
  );

  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  const appendedValues = join.code.flat().filter((
    block,
  ): block is ActionBlock =>
    block instanceof ActionBlock && block.action == "AppendValue"
  );
  assert(
    appendedValues.some((block) =>
      isDynamicSourceNamespaceReference(block.args[1])
    ),
    "namespace.getValues must resolve shape value fields from their source paths",
  );
  assert(
    appendedValues.some((block) => (
      block.args[1] instanceof StringValue &&
      block.args[1].toString().startsWith("__TC_EXT_NS@entity_type@%var(id)@")
    )),
    "namespace.getValues must leave function selectors as selector names",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.IF_VARIABLE &&
      block.action == "=" &&
      block.args.some((argument) =>
        argument instanceof StringValue && argument.value == "on_spawn"
      )
    )),
    "mixed-shape iteration and reflection should branch on function fields",
  );
  assert(
    ![...startup.code.flat(), ...join.code.flat()].some(isDictionaryAction),
    "shape lowering must not emit dictionary actions",
  );
});

Deno.test("nested schema reflection carries source paths instead of namespace values", () => {
  const result = compileScripts([`
        namespace child_schema {
            schema: namespace {
                scale: num;
            };
        }

        namespace parents {
            schema: namespace {
                child: namespace child_schema;
            };
        }

        namespace parents.one {
            namespace child {
                scale: num = 2;
            }
        }

        import parents;
        playerevent join {
            line id = "one";
            line values = namespace.getValues(parents[id]);
            line childFromValues = values[1];
            line directScale = childFromValues.scale;
            line childKeys = namespace.getKeys(childFromValues);
            for (line key, line child of parents[id]) {
                line scale = child.scale;
            }
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
      block.action == "AppendValue" &&
      block.args[1] instanceof StringValue &&
      block.args[1].toString().startsWith("parents@%var(id)@%var(")
    )),
    "namespace.getValues should expose nested namespaces as source paths",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args[0] instanceof VariableValue &&
      renderedVariableName(block.args[0]) == "child" &&
      block.args[1] instanceof StringValue &&
      block.args[1].toString().startsWith("parents@%var(id)@%var(key)")
    )),
    "namespace iteration should assign nested source paths to its value variable",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some((argument) => (
        isDynamicSourceNamespaceReference(argument) &&
        renderedVariableName(argument) == "__TC_EXT_NS@%var(child)@scale"
      ))
    )),
    "nested reflected sources should remain usable for subsequent member access",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some((argument) => (
        isDynamicSourceNamespaceReference(argument) &&
        renderedVariableName(argument) ==
          "__TC_EXT_NS@%var(childFromValues)@scale"
      ))
    )),
    "nested namespace sources returned by getValues should remain usable",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some((argument) => (
        isSourceNamespaceKeyList(argument) &&
        renderedVariableName(argument) == "__TC_EXT_NK@%var(childFromValues)"
      ))
    )),
    "reflection should resolve a nested namespace's key list from its source path",
  );
});

Deno.test("mixed reflection distinguishes values, selectors, and nested sources", () => {
  const result = compileScripts([`
        namespace child_schema {
            schema: namespace {
                scale: num;
            };
        }

        namespace entry {
            schema: namespace {
                amount: num;
                function trigger() -> void;
                child: namespace child_schema;
            };
        }

        namespace entry.one {
            amount: num = 1;
            function trigger() {}
            namespace child {
                scale: num = 2;
            }
        }

        import entry;
        playerevent join {
            line id = "one";
            line values = namespace.getValues(entry[id]);
            for (line key, line value of entry[id]) {}
        }
    `]);

  const hardErrors = result.errors.filter((error) => !error.isWarning);
  assert(
    hardErrors.length == 0,
    hardErrors.map((error) => error.message).join("\n"),
  );
  const join =
    result.compiler.codeLines.get(DFCodeblockName.PLAYER_EVENT)!.Join;
  const appended = join.code.flat().filter((block): block is ActionBlock =>
    block instanceof ActionBlock && block.action == "AppendValue"
  );
  assert(
    appended.some((block) => isDynamicSourceNamespaceReference(block.args[1])),
    "mixed reflection should dereference ordinary value members",
  );
  assert(
    appended.some((block) => (
      block.args[1] instanceof StringValue &&
      block.args[1].toString().startsWith("__TC_EXT_NS@entry@%var(id)@")
    )),
    "mixed reflection should emit function selectors",
  );
  assert(
    appended.some((block) => (
      block.args[1] instanceof StringValue &&
      block.args[1].toString().startsWith("entry@%var(id)@")
    )),
    "mixed reflection should emit nested namespace sources",
  );
  for (const member of ["trigger", "child"]) {
    assert(
      join.code.flat().some((block) => (
        block instanceof ActionBlock &&
        block.block == DFCodeblockName.IF_VARIABLE &&
        block.action == "=" &&
        block.args.some((argument) =>
          argument instanceof StringValue && argument.value == member
        )
      )),
      `mixed reflection should branch for '${member}'`,
    );
  }
});

Deno.test("namespace shape defaults and dynamic function dispatch use source paths", () => {
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
      block.action.startsWith("__TC_EXT_NS@entity_type@%var(id)@on_spawn")
    )),
    "missing dynamic namespace Call Function lowering",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some((argument) => (
        isSourceNamespaceKeyList(argument) &&
        renderedVariableName(argument).includes("entity_type@%var(id)")
      ))
    )),
    "dynamic schema children should support namespace reflection",
  );
  const startup =
    result.compiler.codeLines.get(DFCodeblockName.GAME_EVENT)!.PlotStartup;
  const keyListTargets = startup.code.flat()
    .filter((block): block is ActionBlock =>
      block instanceof ActionBlock && block.action == "CreateList"
    )
    .map((block) => block.args[0])
    .filter((value): value is VariableValue => value instanceof VariableValue)
    .map(renderedVariableName);
  assert(
    keyListTargets.includes(
      getSourceNamespaceKeyListBackendName(["entity_type", "zombie"]),
    ),
    "missing conforming namespace key list",
  );
  assert(
    keyListTargets.includes(
      getSourceNamespaceKeyListBackendName(["handlers"]),
    ),
    "missing function schema key list",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some(isDynamicSourceNamespaceReference)
    )),
    "dynamic nested writes should target the composed backing-variable source",
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
      block.action.startsWith("__TC_EXT_NS@workers@%var(selected)")
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
      block.action.startsWith("__TC_EXT_NS@handlers@%var(selected)")
    )),
    "ordinary mixed-schema calls should dynamically Call Function",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.block == DFCodeblockName.START_PROCESS &&
      block.action.startsWith("__TC_EXT_NS@handlers@%var(selected)")
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
      block.action == "CreateList" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name ==
        getSourceNamespaceKeyListBackendName(["entities", "box", "render"])
    )),
    "missing key list for generated default namespace",
  );
});

Deno.test("conflicting namespace schemas are rejected across files", () => {
  const result = compileScripts([
    `
        namespace duplicate_schema {
            schema: num;
        }
    `,
    `
        namespace duplicate_schema {
            schema: str;
        }
    `,
  ]);

  const messages = result.errors.filter((error) => !error.isWarning).map(
    (error) => error.message,
  );
  assert(
    messages.filter((message) =>
      message.includes("duplicate_schema") &&
      message.includes("more than one schema")
    ).length == 2,
    "each conflicting schema declaration should be diagnosed after cross-file merging",
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

Deno.test("unqualified namespace-variable writes update only their backing variables", () => {
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
      block.action == "=" &&
      block.args[0] instanceof VariableValue &&
      renderedVariableName(block.args[0]) ==
        getSourceNamespaceMemberBackendName(["counters", "one"], "count")
    )),
    "unqualified namespace variable write did not update the backing global variable",
  );
  assert(
    !bump.code.flat().some(isDictionaryAction),
    "direct namespace writes must not require dictionary updates",
  );
});

Deno.test("partial nested defaults and chained dynamic namespace access compose paths", () => {
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
      block.action == "CreateList" &&
      block.args[0] instanceof VariableValue &&
      block.args[0].name == getSourceNamespaceKeyListBackendName(renderPath)
    )),
    "partial default did not materialize its nested namespace key list",
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
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.args.some((argument) => (
        isDynamicSourceNamespaceReference(argument) &&
        renderedVariableName(argument).includes(
          "entity_type@%var(type_id)@%var(member)@scale",
        )
      ))
    )),
    "chained dynamic namespace access did not compose one backing-variable path",
  );
  assert(
    join.code.flat().some((block) => (
      block instanceof ActionBlock &&
      block.action == "=" &&
      block.args.some(isDynamicSourceNamespaceReference)
    )),
    "chained dynamic namespace writes did not target backing variables directly",
  );
  assert(
    ![...startup.code.flat(), ...join.code.flat()].some(isDictionaryAction),
    "chained namespace lowering must not copy values through dictionaries",
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
