; Function-like nodes.
(function_declaration) @function
(function_expression) @function
(arrow_function) @function
(method_definition) @function

; Test callbacks: direct function-like argument of a `test()` / `it()` call.
; Whether it is the qualifying callback (last argument) is resolved in TypeScript.
(call_expression
  function: (identifier) @callee
  (#any-of? @callee "test" "it")
  arguments: (arguments
    [(arrow_function) (function_expression)] @testFunction))

; Comments. The grammar exposes a single `comment` node for both `//` and `/* */`;
; line vs block is classified in TypeScript from the node text prefix.
(comment) @comment