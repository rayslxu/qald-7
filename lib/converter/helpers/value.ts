import assert from 'assert';
import { Ast, Type } from "thingtalk";
import { ENTITY_PREFIX } from "../../utils/wikidata";
import SPARQLToThingTalkConverter from '../sparql2thingtalk';

export interface ValueConverterOptions {
    prefix ?: string
}

export default class ValueConverter {
    private _converter : SPARQLToThingTalkConverter;
    private _prefix : string;

    constructor(converter : SPARQLToThingTalkConverter, options ?: ValueConverterOptions) {
        this._converter = converter;
        this._prefix = options?.prefix ?? ENTITY_PREFIX;
    }

    async toThingTalkValue(value : any, type : Type) : Promise<Ast.Value> {
        if (type instanceof Type.Entity) {
            assert(typeof value === 'string' && value.startsWith(this._prefix));
            value = value.slice(this._prefix.length);
            return new Ast.Value.Entity(value, type.type, null); 
        } 
        if (type instanceof Type.Enum) {
            assert(typeof value === 'string' && value.startsWith(this._prefix));
            value = value.slice(this._prefix.length);
            const wikidataLabel = await this._converter.kb.getLabel(value);
            assert(wikidataLabel);
            return new Ast.Value.Enum(wikidataLabel); 
        }
        if (type === Type.Number)
            return new Ast.Value.Number(parseFloat(value));
        if (type === Type.String) 
            return new Ast.Value.String(value);
        if (type instanceof Type.Compound)
            return this.toThingTalkValue(value, type.fields.value.type);

        throw new Error('Unsupported value type: ' + type);
    }
}