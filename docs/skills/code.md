# Code Generation Skill

Purpose: produce useful source code without scaffolding noise.

Rules:

- Start with the complete compilable source file in a fenced code block.
- Put explanation, compile notes, and usage notes after the code.
- Do not introduce the answer with a rewritten version of the user's request.
- Do not use ellipses, TODO comments, placeholder bodies, omitted implementation notes, or pseudo-code.
- Include imports, classes, functions, data structures, file operations, menu/input handling, and error handling when the user asks for a complete program.
- For small complete programs with explanation, split work into a code section and an explanation section when decomposition is available.
- For large programs, prefer responsibility-based chunks: contract, data model, core functions, UI or CLI flow, validation, tests, and final assembly.

