/// <reference types="node" />
import { Ast } from 'thingtalk';
export declare function snakeCase(v: string): string;
export declare function removeAccent(v: string): string;
export declare function cleanName(v: string): string;
export declare function idArgument(entityType: string): Ast.ArgumentDef;
export declare function waitFinish(stream: NodeJS.WritableStream): Promise<void>;
export declare function similarity(s1: string, s2: string, algorithm?: 'jaccard' | 'f1'): number;
export declare function closest(s: string, arr: string[], algorithm?: 'jaccard' | 'f1', discard_threshold?: number): string | null;
