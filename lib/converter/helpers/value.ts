import assert from 'assert';
import { Ast, Type } from "thingtalk";
import { ENTITY_PREFIX } from "../../utils/wikidata";
import { ENTITY_SPAN_OVERRIDE } from '../../utils/qald';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';
import { closest } from '../../utils/misc';

export interface ValueConverterOptions {
    exclude_entity_display : boolean,
    prefix ?: string
}

export default class ValueConverter {
    private _converter : SPARQLToThingTalkConverter;
    private _excludeEntityValue : boolean;
    private _prefix : string;

    constructor(converter : SPARQLToThingTalkConverter, options ?: ValueConverterOptions) {
        this._converter = converter;
        this._excludeEntityValue = options?.exclude_entity_display ?? false;
        this._prefix = options?.prefix ?? ENTITY_PREFIX;
    }

    private async _getEntityDisplay(qid : string) {
        const wikidataLabel = await this._converter.kb.getLabel(qid);
        assert(wikidataLabel);
        const display = closest(wikidataLabel, this._converter.keywords);
        if (display)
            return display;
        if (qid in ENTITY_SPAN_OVERRIDE)
            return ENTITY_SPAN_OVERRIDE[qid];
        throw new Error(`Failed to find matching span for entity ${display}(${qid})`);
    }

    async toThingTalkValue(value : any, type : Type) : Promise<Ast.Value> {
        if (type instanceof Type.Entity) {
            assert(typeof value === 'string' && value.startsWith(this._prefix));
            const qid = value.slice(this._prefix.length);
            const display = this._excludeEntityValue ? null : await this._getEntityDisplay(qid);
            return new Ast.Value.Entity(qid, type.type, display); 
        } 
        if (type instanceof Type.Enum) {
            assert(typeof value === 'string' && value.startsWith(this._prefix));
            value = value.slice(this._prefix.length);
            const wikidataLabel = await this._converter.kb.getLabel(value);
            assert(wikidataLabel);
            return new Ast.Value.Enum(wikidataLabel); 
        }
        if (type instanceof Type.Measure) 
            return new Ast.Value.Measure(parseFloat(value), type.unit);
        if (type === Type.Number)
            return new Ast.Value.Number(parseFloat(value));
        if (type === Type.String) 
            return new Ast.Value.String(value);
        if (type instanceof Type.Compound)
            return this.toThingTalkValue(value, type.fields.value.type);

        throw new Error('Unsupported value type: ' + type);
    }
}