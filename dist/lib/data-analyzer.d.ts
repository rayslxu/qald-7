/// <reference types="node" />
import Stream from 'stream';
import { Ast, Type } from 'thingtalk';
interface SentenceExample {
    target_code: string;
}
interface AnalyzeResult {
    type: Type;
    num_projection: number;
    num_filter: number;
    num_count: number;
    num_total: number;
}
export declare class Analyzer extends Stream.Writable {
    private _classDef;
    private _result;
    constructor(classDef: Ast.ClassDef);
    analyze(thingtalk: string): void;
    _write(ex: SentenceExample, encoding: BufferEncoding, callback: () => void): void;
    read(): Promise<Record<string, AnalyzeResult>>;
}
export {};
