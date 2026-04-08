// ============================================================
// IOZEN Language — Main Entry Point
// Exports the complete IOZEN language toolkit
// ============================================================

export type * from './ast';
export { Environment, RuntimeError } from './environment';
export { Interpreter, executeIOZEN } from './interpreter';
export { Lexer } from './lexer';
export { ParseError, Parser } from './parser';
export { KEYWORDS, SYMBOLS, Token, TokenType } from './tokens';

// Language metadata
export const IOZEN_VERSION = '0.1.0';
export const IOZEN_NAME = 'IOZEN';
export const IOZEN_DESCRIPTION = 'A safe, expressive systems programming language with natural syntax';
