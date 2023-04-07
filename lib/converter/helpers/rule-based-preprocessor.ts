import WikidataUtils from '../../utils/wikidata';
import { normalize } from '../../utils/sparqljs';

export class RuleBasedPreprocessor {
    private _wikidata : WikidataUtils;

    constructor(wikidata : WikidataUtils) {
        this._wikidata = wikidata;
    }

    async _leader(code : string, type : 'thingtalk'|'sparql') : Promise<string|null> {
        if (type === 'thingtalk') {
            const regex = new RegExp('\\[ (head_of_government|head_of_state) filter \\( point_in_time == new Date \\( ([0-9]+) \\) \\) \\] of @wd . (country|entity) \\( \\) filter id == " (Q[0-9]+) "');
            const match = regex.exec(code);
            if (!match)
                return null;
            const year = match[2];
            const country = match[4];
            const office_held_by_property = match[1] === 'head_of_government' ? 'P1313' : 'P1906';
            const result = await this._wikidata.query(`SELECT DISTINCT ?x WHERE {
                wd:${country} wdt:${office_held_by_property} ?x.
            }`);
            if (result.length === 0) {
                console.warn(`Cannot find entity for ${country}'s ${office_held_by_property}`);
                return null;
            }
            const position = result[0];
            return `@wd . entity ( ) filter contains ( position_held filter ( point_in_time == new Date ( ${year} ) ) , " ${position} " ^^wd:p_position_held ) ;`;
        } else {
            const normalized = normalize(code);
            const pRegex = new RegExp(`\\?([x|y|z]) <http://www\\.wikidata\\.org/prop/P39> \\?([p|q])`);
            const pMatch = pRegex.exec(normalized);
            if (!pMatch)
                return null;
            const xVariable = pMatch[1];
            const pVariable = pMatch[2];

            const psRegex = new RegExp(normalize(`\\?${pVariable} <http://www\\.wikidata\\.org/prop/statement/P39> <http://www\\.wikidata\\.org/entity/(Q[0-9]+)>`));
            const psMatch = psRegex.exec(normalized);
            if (!psMatch)
                return null;
            const position_held = psMatch[1];
            const office_held_by : Record<string, string> = {
                'P1313': 'P6',
                'P1906': 'P35'
            };
            let country, held_by;
            for (const office in office_held_by) {
                const result = await this._wikidata.query(`SELECT DISTINCT ?x WHERE {
                    ?x wdt:${office} wd:${position_held}.
                }`);
                if (result.length > 0) {
                    country = result[0];
                    held_by = office_held_by[office];
                    break;
                }
            }
            if (!country)
                return null;
            
            return normalized
                .replace(pRegex, `<http://www.wikidata.org/entity/${country}> <http://www.wikidata.org/prop/${held_by}> ?${pVariable}`)
                .replace(psRegex, `?${pVariable} <http://www.wikidata.org/prop/statement/${held_by}> ?${xVariable}`);
        }
    }

    async preprocess(code : string, type : 'thingtalk'|'sparql') : Promise<string> {
        let processed : string|null;
        if ((processed = await this._leader(code, type)) !== null)
            return processed;
        return code;
    }
}  