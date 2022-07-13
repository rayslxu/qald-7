import assert from 'assert';
import { Ast, Type } from "thingtalk";
import * as Units from 'thingtalk-units';
import wordsToNumbers from 'words-to-numbers';
import { ENTITY_PREFIX } from "../../utils/wikidata";
import { ENTITY_SPAN_OVERRIDE } from '../../utils/qald';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';
import { closest } from '../../utils/misc';

// TODO: more nl to thingtalk units 
const unitsMapper : Record<string, string> = {
    'meters': 'm',
};

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

    private _getMeasure(value : number, baseUnit : string) : [number, string] {
        const tokens = wordsToNumbers(this._converter.utterance!)!.toString().split(' ');
        for (let i = 0; i < tokens.length - 1; i ++) {
            const number = parseFloat(tokens[i]);
            if (isNaN(number))
                continue;
            const unit = unitsMapper[tokens[i+1]];
            if (!unit)
                continue;
            if (Units.normalizeUnit(unit) !== baseUnit)
                continue;
            return [number, unit];
        }
        throw new Error(`Failed to find matching measure in the utterance: ${value} ${baseUnit}`);
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
        if (type instanceof Type.Measure) {
            const [number, unit] = this._getMeasure(parseFloat(value), type.unit);
            return new Ast.Value.Measure(number, unit);
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