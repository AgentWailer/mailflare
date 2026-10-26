// Import only the public parser/traversal/generator entry points. The full
// css-tree entry also initializes its property grammar and validation lexer.
import parse from "css-tree/parser";
import walk from "css-tree/walker";
import generate from "css-tree/generator";
export { ident } from "css-tree/utils";
export { parse, walk, generate };
export const find = walk.find;
export type { Declaration } from "css-tree";
