import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { Ast } from 'thingtalk';
interface PostProcessorOptions {
    tpClient: Tp.BaseClient;
    schemas: ThingTalk.SchemaRetriever;
    class: Ast.ClassDef;
    normalizeDomains: 'always' | 'id-filtered-only' | 'never';
    normalizeEntityTypes: boolean;
    includeEntityValue: boolean;
    excludeEntityDisplay: boolean;
}
export declare class PostProcessor {
    private _tpClient;
    private _schemas;
    private _normalizer;
    private _includeEntityValue;
    private _excludeEntityDisplay;
    constructor(options: PostProcessorOptions);
    postprocess(thingtalk: string, preprocessedUtterance: string): Promise<string[]>;
}
export {};
