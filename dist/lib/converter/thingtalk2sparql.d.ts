import { Ast } from "thingtalk";
interface Entity {
    value: string;
    name: string;
    canonical: string;
}
interface ThingTalkToSPARQLConverterOptions {
    locale: string;
    timezone?: string;
    cache: string;
    bootleg: string;
}
export default class ThingTalkToSPARQLConverter {
    private _classDef;
    private _locale;
    private _timezone?;
    private _kb;
    private _propertyMap;
    private _domainMap;
    private _entityVariableCount;
    private _statements;
    constructor(classDef: Ast.ClassDef, entities: Entity[], options: ThingTalkToSPARQLConverterOptions);
    getEntityVariable(): string;
    getWikidataProperty(property: string): string;
    getWikidataDomain(domain: string): Promise<string | null>;
    private _convertSingleTable;
    convert(utterance: string, thingtalk: string): Promise<string>;
}
export {};
