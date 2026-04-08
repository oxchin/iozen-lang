// ============================================================
// IOZEN Language — Interpreter (Tree-Walking)
// Executes IOZEN programs by walking the AST
// ============================================================

import { Lexer } from './lexer';
import { Parser } from './parser';
import { ParseError } from './parser';
import { Environment, RuntimeError, IOZENValue, IOZENResult, IOZENObject, IOZENFunction } from './environment';
import type {
  ASTNode, ProgramNode, VariableDeclNode, FunctionDeclNode,
  StructureDeclNode, EnumDeclNode, PrintStmtNode, ReturnStmtNode,
  WhenNode, CheckNode, RepeatNode, WhileNode, ForEachNode,
  IncreaseNode, SetFieldNode, AssignVarNode, FunctionCallStmtNode, BlockNode,
  BinaryExprNode, UnaryExprNode, AttachExprNode, IdentifierNode,
  LiteralNode, FunctionCallExprNode, MemberAccessNode,
  IndexAccessNode, ListLiteralNode, HasValueNode, ValueInsideNode,
} from './ast';

// Special signal to unwind the call stack for return/exit
class ReturnSignal {
  constructor(public value: IOZENValue) {}
}

class ExitSignal {
  constructor(public target: string | null) {}
}

export class Interpreter {
  private env: Environment;
  private output: string[] = [];
  private maxIterations: number = 100000;
  private iterationCount: number = 0;
  private structureDefs: Map<string, { fields: { name: string; typeName: string }[] }> = new Map();

  constructor() {
    this.env = new Environment();
    this.registerBuiltins();
  }

  public run(source: string): { output: string[]; errors: string[] } {
    this.output = [];
    this.iterationCount = 0;

    try {
      const lexer = new Lexer(source);
      const tokens = lexer.tokenize();
      const parser = new Parser(tokens);
      const ast = parser.parse();

      this.executeBlock(ast.statements, this.env);
    } catch (e) {
      if (e instanceof ParseError) {
        return {
          output: [],
          errors: [`Parse error at line ${e.token.line}, column ${e.token.column}: ${e.message}`],
        };
      }
      if (e instanceof RuntimeError) {
        return {
          output: this.output,
          errors: [`Runtime error: ${e.message}`],
        };
      }
      if (e instanceof Error) {
        return {
          output: this.output,
          errors: [`Error: ${e.message}`],
        };
      }
      return {
        output: this.output,
        errors: [`Unknown error: ${String(e)}`],
      };
    }

    return { output: this.output, errors: [] };
  }

  private execute(node: ASTNode, env: Environment): void {
    this.checkIterationLimit();

    switch (node.kind) {
      case 'Program':
        this.executeBlock(node.statements, env);
        break;
      case 'VariableDecl':
        this.execVariableDecl(node as VariableDeclNode, env);
        break;
      case 'FunctionDecl':
        this.execFunctionDecl(node as FunctionDeclNode, env);
        break;
      case 'StructureDecl':
        this.execStructureDecl(node as StructureDeclNode);
        break;
      case 'EnumDecl':
        this.execEnumDecl(node as EnumDeclNode);
        break;
      case 'PrintStmt':
        this.execPrint(node as PrintStmtNode, env);
        break;
      case 'ReturnStmt':
        this.execReturn(node as ReturnStmtNode, env);
        break;
      case 'When':
        this.execWhen(node as WhenNode, env);
        break;
      case 'Check':
        this.execCheck(node as CheckNode, env);
        break;
      case 'Repeat':
        this.execRepeat(node as RepeatNode, env);
        break;
      case 'While':
        this.execWhile(node as WhileNode, env);
        break;
      case 'ForEach':
        this.execForEach(node as ForEachNode, env);
        break;
      case 'Increase':
        this.execIncrease(node as IncreaseNode, env);
        break;
      case 'SetField':
        this.execSetField(node as SetFieldNode, env);
        break;
      case 'AssignVar':
        this.execAssignVar(node as AssignVarNode, env);
        break;
      case 'FunctionCallStmt':
        this.execFunctionCallStmt(node as FunctionCallStmtNode, env);
        break;
      case 'Block':
        this.executeBlock(node.statements, env);
        break;
      default:
        // If it's an expression, evaluate it (side effects)
        this.evaluate(node, env);
        break;
    }
  }

  private executeBlock(statements: ASTNode[], env: Environment): void {
    for (const stmt of statements) {
      this.execute(stmt, env);
    }
  }

  // ---- Statement Executors ----

  private execVariableDecl(node: VariableDeclNode, env: Environment): void {
    let value: IOZENValue;

    if (node.value) {
      value = this.evaluate(node.value, env);
    } else {
      // Default values based on type
      value = this.getDefaultValue(node.typeName);
    }

    env.define(node.name, value, node.isConstant);
  }

  private execFunctionDecl(node: FunctionDeclNode, env: Environment): void {
    const func: IOZENFunction = {
      __iozen_type: 'function',
      name: node.name,
      parameters: node.parameters,
      returnType: node.returnType,
      body: node.body,
      closure: env,
    };
    env.define(node.name, func);
  }

  private execStructureDecl(node: StructureDeclNode): void {
    this.structureDefs.set(node.name.toLowerCase(), { fields: node.fields });
  }

  private execEnumDecl(node: EnumDeclNode): void {
    // Register enum constructors in the environment
    for (const enumCase of node.cases) {
      env.define(enumCase.name, {
        __iozen_type: 'function',
        name: enumCase.name,
        parameters: enumCase.fields.map(f => ({ name: f.name, typeName: f.typeName, qualifiers: [] })),
        returnType: node.name,
        body: [],
        closure: env,
      });
    }
  }

  private execPrint(node: PrintStmtNode, env: Environment): void {
    const parts: string[] = [];
    for (const expr of node.expressions) {
      const val = this.evaluate(expr, env);
      parts.push(this.iozenValueToString(val));
    }
    this.output.push(parts.join(''));
  }

  private execReturn(node: ReturnStmtNode, env: Environment): void {
    const value = node.value ? this.evaluate(node.value, env) : null;
    throw new ReturnSignal(value);
  }

  private execWhen(node: WhenNode, env: Environment): void {
    for (const branch of node.branches) {
      const cond = this.evaluate(branch.condition, env);
      if (this.isTruthy(cond)) {
        this.executeBlock(branch.body, env);
        return;
      }
    }

    if (node.otherwise) {
      this.executeBlock(node.otherwise, env);
    }
  }

  private execCheck(node: CheckNode, env: Environment): void {
    const target = this.evaluate(node.target, env);

    if (target && typeof target === 'object' && (target as IOZENResult).__iozen_type === 'result') {
      const result = target as IOZENResult;

      for (const checkCase of node.cases) {
        if ((result.ok && checkCase.name === 'Ok') || (!result.ok && checkCase.name === 'Error')) {
          const caseEnv = env.child();

          if (checkCase.binding) {
            caseEnv.define(checkCase.binding, result.ok ? result.value! : result.error!);
          }

          this.executeBlock(checkCase.body, caseEnv);
          return;
        }
      }
    }
  }

  private execRepeat(node: RepeatNode, env: Environment): void {
    const count = Math.floor(this.toNumber(this.evaluate(node.count, env)));
    const envWithCounter = env.child();

    for (let i = 0; i < count; i++) {
      envWithCounter.define('__index__', i);
      try {
        this.executeBlock(node.body, envWithCounter);
      } catch (e) {
        if (e instanceof ExitSignal) {
          if (e.target === node.label || !e.target) break;
          throw e; // re-throw if targeting outer loop
        }
        throw e;
      }
    }
  }

  private execWhile(node: WhileNode, env: Environment): void {
    while (this.isTruthy(this.evaluate(node.condition, env))) {
      try {
        this.executeBlock(node.body, env);
      } catch (e) {
        if (e instanceof ExitSignal) throw e;
        throw e;
      }
    }
  }

  private execForEach(node: ForEachNode, env: Environment): void {
    const iterable = this.evaluate(node.iterable, env);

    if (Array.isArray(iterable)) {
      const childEnv = env.child();
      for (const item of iterable) {
        childEnv.define(node.variable, item);
        this.executeBlock(node.body, childEnv);
      }
    } else if (typeof iterable === 'string') {
      const childEnv = env.child();
      for (const ch of iterable) {
        childEnv.define(node.variable, ch);
        this.executeBlock(node.body, childEnv);
      }
    } else {
      throw new RuntimeError(`Cannot iterate over ${typeof iterable}`);
    }
  }

  private execIncrease(node: IncreaseNode, env: Environment): void {
    const target = this.evaluate(node.target, env);
    const amount = this.toNumber(this.evaluate(node.amount, env));

    if (node.target.kind === 'Identifier') {
      const name = (node.target as IdentifierNode).name;
      const current = this.toNumber(env.get(name));
      env.set(name, current + amount);
    }
  }

  private execSetField(node: SetFieldNode, env: Environment): void {
    const targetName = node.fieldPath[0];
    const obj = env.get(targetName) as IOZENObject;

    if (node.fieldPath.length === 2) {
      obj[node.fieldPath[1]] = this.evaluate(node.value, env);
    } else {
      // Nested field access
      let current: IOZENValue = obj;
      for (let i = 1; i < node.fieldPath.length - 1; i++) {
        current = (current as IOZENObject)[node.fieldPath[i]];
      }
      (current as IOZENObject)[node.fieldPath[node.fieldPath.length - 1]] = this.evaluate(node.value, env);
    }
  }

  private execAssignVar(node: AssignVarNode, env: Environment): void {
    const value = this.evaluate(node.value, env);
    env.set(node.name, value);
  }

  private execFunctionCallStmt(node: FunctionCallStmtNode, env: Environment): void {
    this.callFunction(node.name, node.arguments, env);
  }

  // ---- Expression Evaluator ----

  private evaluate(node: ASTNode, env: Environment): IOZENValue {
    switch (node.kind) {
      case 'Literal':
        return (node as LiteralNode).value;

      case 'Identifier':
        return env.get((node as IdentifierNode).name);

      case 'BinaryExpr': {
        const b = node as BinaryExprNode;
        const left = this.evaluate(b.left, env);
        const right = this.evaluate(b.right, env);
        return this.evalBinary(b.operator, left, right);
      }

      case 'UnaryExpr': {
        const u = node as UnaryExprNode;
        const operand = this.evaluate(u.operand, env);
        return this.evalUnary(u.operator, operand);
      }

      case 'AttachExpr': {
        const a = node as AttachExprNode;
        const parts: string[] = [];
        for (const part of a.parts) {
          const val = this.evaluate(part, env);
          parts.push(this.iozenValueToString(val));
        }
        return parts.join('');
      }

      case 'FunctionCallExpr': {
        const f = node as FunctionCallExprNode;
        return this.callFunction(f.name, f.arguments, env);
      }

      case 'MemberAccess': {
        const m = node as MemberAccessNode;
        const obj = this.evaluate(m.object, env);
        if (obj && typeof obj === 'object' && m.field in obj) {
          return (obj as Record<string, IOZENValue>)[m.field];
        }
        throw new RuntimeError(`Cannot access field "${m.field}"`);
      }

      case 'IndexAccess': {
        const i = node as IndexAccessNode;
        const obj = this.evaluate(i.object, env);
        const idx = Math.floor(this.toNumber(this.evaluate(i.index, env)));
        if (Array.isArray(obj)) {
          return obj[idx];
        }
        if (typeof obj === 'string') {
          return obj[idx];
        }
        throw new RuntimeError(`Cannot index ${typeof obj}`);
      }

      case 'ListLiteral': {
        const l = node as ListLiteralNode;
        return l.elements.map(el => this.evaluate(el, env));
      }

      case 'HasValue': {
        const h = node as HasValueNode;
        const val = this.evaluate(h.expression, env);
        return val !== null && val !== undefined;
      }

      case 'ValueInside': {
        const v = node as ValueInsideNode;
        const val = this.evaluate(v.expression, env);
        if (val && typeof val === 'object' && (val as IOZENResult).__iozen_type === 'result') {
          return (val as IOZENResult).ok ? (val as IOZENResult).value! : null;
        }
        return val;
      }

      default:
        throw new RuntimeError(`Unknown expression kind: ${(node as ASTNode).kind}`);
    }
  }

  private evalBinary(op: string, left: IOZENValue, right: IOZENValue): IOZENValue {
    switch (op) {
      case '+':
        if (typeof left === 'string' || typeof right === 'string') {
          return String(left) + String(right);
        }
        return this.toNumber(left) + this.toNumber(right);
      case '-': return this.toNumber(left) - this.toNumber(right);
      case '*': return this.toNumber(left) * this.toNumber(right);
      case '/':
        if (this.toNumber(right) === 0) throw new RuntimeError('Division by zero');
        return this.toNumber(left) / this.toNumber(right);
      case '%': return this.toNumber(left) % this.toNumber(right);
      case '==': return left === right;
      case '!=': return left !== right;
      case '<': return this.toNumber(left) < this.toNumber(right);
      case '>': return this.toNumber(left) > this.toNumber(right);
      case '<=': return this.toNumber(left) <= this.toNumber(right);
      case '>=': return this.toNumber(left) >= this.toNumber(right);
      case 'and': return this.isTruthy(left) && this.isTruthy(right);
      case 'or': return this.isTruthy(left) || this.isTruthy(right);
      default:
        throw new RuntimeError(`Unknown operator: ${op}`);
    }
  }

  private evalUnary(op: string, operand: IOZENValue): IOZENValue {
    switch (op) {
      case '-': return -this.toNumber(operand);
      case 'not': return !this.isTruthy(operand);
      default:
        throw new RuntimeError(`Unknown unary operator: ${op}`);
    }
  }

  // ---- Function Calling ----

  private callFunction(name: string, argNodes: ASTNode[], env: Environment): IOZENValue {
    // Evaluate arguments
    const args = argNodes.map(a => this.evaluate(a, env));

    // Built-in functions (try all built-in routes first)
    if (this.callBuiltin(name, args)) {
      return this.env.get('__last_result__');
    }
    if (this.callBuiltinByName(name, args)) {
      return this.env.get('__last_result__');
    }

    // User-defined function
    let func: IOZENFunction | undefined;
    try {
      func = env.get(name) as IOZENFunction;
    } catch {
      // Function not found in env — fall through to error
    }

    if (func && func.__iozen_type === 'function') {
      if (func.body.length === 0) {
        // Enum constructor — create a result-like object
        if (args.length === 1) {
          return { __iozen_type: 'result', ok: true, value: args[0] } as IOZENResult;
        }
        return { __iozen_type: 'result', ok: false, error: String(args[0] || 'unknown error') } as IOZENResult;
      }

      // Create new scope for function
      const funcEnv = func.closure.child();

      // Bind parameters
      for (let i = 0; i < func.parameters.length && i < args.length; i++) {
        funcEnv.define(func.parameters[i].name, args[i]);
      }

      // Execute body
      try {
        this.executeBlock(func.body, funcEnv);
      } catch (e) {
        if (e instanceof ReturnSignal) {
          return e.value;
        }
        throw e;
      }

      return null;
    }

    // Unknown function — try as math/built-in
    if (this.callBuiltinByName(name, args)) {
      return this.env.get('__last_result__');
    }

    throw new RuntimeError(`Undefined function: "${name}"`);
  }

  // ---- Built-in Functions ----

  private registerBuiltins(): void {
    // Registered via callBuiltin
  }

  private callBuiltin(name: string, args: IOZENValue[]): boolean {
    switch (name.toLowerCase()) {
      case '__print__':
      case 'println': {
        const text = args.map(a => this.iozenValueToString(a)).join(' ');
        this.output.push(text);
        this.env.define('__last_result__', null);
        return true;
      }
      case '__size__': {
        const val = args[0];
        if (Array.isArray(val)) {
          this.env.define('__last_result__', val.length);
        } else if (typeof val === 'string') {
          this.env.define('__last_result__', val.length);
        } else {
          this.env.define('__last_result__', 0);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private callBuiltinByName(name: string, args: IOZENValue[]): boolean {
    const n = name.toLowerCase();

    // Math functions
    if (n === 'abs' && args.length >= 1) {
      this.env.define('__last_result__', Math.abs(this.toNumber(args[0])));
      return true;
    }
    if (n === 'sqrt' && args.length >= 1) {
      this.env.define('__last_result__', Math.sqrt(this.toNumber(args[0])));
      return true;
    }
    if (n === 'floor' && args.length >= 1) {
      this.env.define('__last_result__', Math.floor(this.toNumber(args[0])));
      return true;
    }
    if (n === 'ceil' && args.length >= 1) {
      this.env.define('__last_result__', Math.ceil(this.toNumber(args[0])));
      return true;
    }
    if (n === 'round' && args.length >= 1) {
      this.env.define('__last_result__', Math.round(this.toNumber(args[0])));
      return true;
    }
    if (n === 'power' && args.length >= 2) {
      this.env.define('__last_result__', Math.pow(this.toNumber(args[0]), this.toNumber(args[1])));
      return true;
    }
    if (n === 'min' && args.length >= 2) {
      this.env.define('__last_result__', Math.min(this.toNumber(args[0]), this.toNumber(args[1])));
      return true;
    }
    if (n === 'max' && args.length >= 2) {
      this.env.define('__last_result__', Math.max(this.toNumber(args[0]), this.toNumber(args[1])));
      return true;
    }

    // String functions
    if (n === 'uppercase' && args.length >= 1) {
      this.env.define('__last_result__', String(args[0]).toUpperCase());
      return true;
    }
    if (n === 'lowercase' && args.length >= 1) {
      this.env.define('__last_result__', String(args[0]).toLowerCase());
      return true;
    }
    if (n === 'trim' && args.length >= 1) {
      this.env.define('__last_result__', String(args[0]).trim());
      return true;
    }
    if (n === 'substring' && args.length >= 3) {
      this.env.define('__last_result__', String(args[0]).substring(
        this.toNumber(args[1]), this.toNumber(args[2])
      ));
      return true;
    }
    if (n === 'contains' && args.length >= 2) {
      this.env.define('__last_result__', String(args[0]).includes(String(args[1])));
      return true;
    }
    if (n === 'replace' && args.length >= 3) {
      this.env.define('__last_result__', String(args[0]).replaceAll(String(args[1]), String(args[2])));
      return true;
    }
    if (n === 'split' && args.length >= 2) {
      this.env.define('__last_result__', String(args[0]).split(String(args[1])));
      return true;
    }
    if (n === 'char_at' && args.length >= 2) {
      this.env.define('__last_result__', String(args[0])[Math.floor(this.toNumber(args[1]))]);
      return true;
    }
    if (n === 'ord' && args.length >= 1) {
      const str = String(args[0]);
      this.env.define('__last_result__', str.length > 0 ? str.charCodeAt(0) : 0);
      return true;
    }
    if (n === 'chr' && args.length >= 1) {
      this.env.define('__last_result__', String.fromCharCode(Math.floor(this.toNumber(args[0]))));
      return true;
    }

    // Type conversion
    if (n === 'to_integer' || n === 'int' && args.length >= 1) {
      this.env.define('__last_result__', parseInt(String(args[0]), 10));
      return true;
    }
    if (n === 'to_float' && args.length >= 1) {
      this.env.define('__last_result__', parseFloat(String(args[0])));
      return true;
    }
    if (n === 'to_text' && args.length >= 1) {
      this.env.define('__last_result__', String(args[0]));
      return true;
    }

    // List functions
    if (n === 'push' && args.length >= 2 && Array.isArray(args[0])) {
      (args[0] as IOZENValue[]).push(args[1]);
      this.env.define('__last_result__', args[0]);
      return true;
    }
    if (n === 'pop' && args.length >= 1 && Array.isArray(args[0])) {
      this.env.define('__last_result__', (args[0] as IOZENValue[]).pop() || null);
      return true;
    }
    if (n === 'sort' && args.length >= 1 && Array.isArray(args[0])) {
      this.env.define('__last_result__', [...(args[0] as IOZENValue[])].sort((a, b) => {
        const na = this.toNumber(a);
        const nb = this.toNumber(b);
        return na - nb;
      }));
      return true;
    }
    if (n === 'reverse' && args.length >= 1 && Array.isArray(args[0])) {
      this.env.define('__last_result__', [...(args[0] as IOZENValue[])].reverse());
      return true;
    }
    if (n === 'join' && args.length >= 2 && Array.isArray(args[0])) {
      this.env.define('__last_result__', (args[0] as IOZENValue[]).map(a => String(a)).join(String(args[1])));
      return true;
    }
    if (n === 'range' && args.length >= 2) {
      const start = this.toNumber(args[0]);
      const end = this.toNumber(args[1]);
      const arr: IOZENValue[] = [];
      for (let i = start; i < end; i++) arr.push(i);
      this.env.define('__last_result__', arr);
      return true;
    }
    if (n === 'sum' && args.length >= 1 && Array.isArray(args[0])) {
      this.env.define('__last_result__', (args[0] as IOZENValue[]).reduce((s, v) => s + this.toNumber(v), 0));
      return true;
    }
    if (n === 'length' && args.length >= 1) {
      const v = args[0];
      if (Array.isArray(v)) this.env.define('__last_result__', v.length);
      else if (typeof v === 'string') this.env.define('__last_result__', v.length);
      else this.env.define('__last_result__', 0);
      return true;
    }

    // Special IOZEN keywords that function as built-ins
    if (n === 'read_file' && args.length >= 1) {
      // In a real implementation, this would read a file
      // For the playground, we return a mock string
      this.env.define('__last_result__', `[file content of "${args[0]}"]`);
      return true;
    }

    return false;
  }

  // ---- Type Helpers ----

  private isTruthy(value: IOZENValue): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0;
    return true;
  }

  private toNumber(value: IOZENValue): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
      const n = parseFloat(value);
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  private iozenValueToString(value: IOZENValue): string {
    if (value === null || value === undefined) return 'nothing';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? value.toString() : value.toFixed(6).replace(/\.?0+$/, '');
    }
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return `[${value.map(v => this.iozenValueToString(v)).join(', ')}]`;
    if (typeof value === 'object') {
      if ((value as IOZENResult).__iozen_type === 'result') {
        const r = value as IOZENResult;
        return r.ok ? `Ok(${this.iozenValueToString(r.value!)})` : `Error("${r.error}")`;
      }
      if ((value as IOZENObject).__iozen_type === 'object') {
        const obj = value as IOZENObject;
        const fields = Object.entries(obj)
          .filter(([k]) => !k.startsWith('__'))
          .map(([k, v]) => `${k}: ${this.iozenValueToString(v)}`);
        return `${obj.__class_name} { ${fields.join(', ')} }`;
      }
      return JSON.stringify(value);
    }
    if (typeof value === 'function') return '<function>';
    return String(value);
  }

  private getDefaultValue(typeName: string): IOZENValue {
    const t = typeName.toLowerCase();
    if (t.includes('integer') || t.includes('int')) return 0;
    if (t.includes('float')) return 0.0;
    if (t.includes('boolean') || t.includes('bool')) return false;
    if (t.includes('text') || t.includes('string')) return '';
    if (t.includes('character') || t.includes('char')) return '\0';
    if (t.includes('list') || t.includes('array')) return [];
    if (t.includes('pointer') || t.includes('address')) return null;
    if (t.includes('optional')) return null;
    return null;
  }

  private checkIterationLimit(): void {
    this.iterationCount++;
    if (this.iterationCount > this.maxIterations) {
      throw new RuntimeError('Execution limit exceeded (possible infinite loop)');
    }
  }
}

// ---- Convenience API ----

export function executeIOZEN(source: string): { output: string[]; errors: string[] } {
  const interpreter = new Interpreter();
  return interpreter.run(source);
}
