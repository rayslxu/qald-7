import { 
    ENTITY_PREFIX,
    PROPERTY_PREFIX,
    PROPERTY_PREDICATE_PREFIX,
    PROPERTY_QUALIFIER_PREFIX,
    PROPERTY_STATEMENT_PREFIX
} from '../../utils/wikidata';

const patterns = {
    // who are the current senators from XXX (state) ?
    '@wd . entity ( ) filter contains ( position_held filter contains ( < electoral_district / located_in_the_administrative_territorial_entity > , " $0 " ^^wd:p_located_in_the_administrative_territorial_entity ) , " Q4416090 " ^^wd:p_position_held ) ;': 
    `SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/P39> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P39> <http://www.wikidata.org/entity/Q4416090>. 
        ?p <http://www.wikidata.org/prop/qualifier/P768> ?y.  
        ?y <http://www.wikidata.org/prop/direct/P131> <http://www.wikidata.org/entity/$0>. 
        FILTER NOT EXISTS { ?p <http://www.wikidata.org/prop/qualifier/P582> ?z. }
    }`, 

    // what state is barack obama senator for ?
    '[ < electoral_district / located_in_the_administrative_territorial_entity > of position_held filter value == " Q4416090 " ^^wd:p_position_held ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P39> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P39> <http://www.wikidata.org/entity/Q4416090>. 
        ?p <http://www.wikidata.org/prop/qualifier/P768> ?y. 
        ?y <http://www.wikidata.org/prop/direct/P131> ?x. 
    }`
};

const prefixes : Record<string, string> = {
    'wd': ENTITY_PREFIX,
    'wdt': PROPERTY_PREFIX,
    'p': PROPERTY_PREDICATE_PREFIX,
    'pq': PROPERTY_QUALIFIER_PREFIX,
    'ps': PROPERTY_STATEMENT_PREFIX
};

// convert examples based on manual patterns 
export class PatternConverter {
    private _patterns : Array<{ thingtalk : string, sparql : string }>;

    constructor() {
        this._patterns = [];
        this._loadPatterns();
    }

    private _normalize(sparql : string) : string {
        const regex = new RegExp('(wd|wdt|p|pq|ps):([P|Q][0-9]+)', 'g');
        for (const [abbr, prefix] of Object.entries(prefixes)) {
            sparql = sparql.replace(`PREFIX ${abbr}: <${prefix}>`, '');
            let match;
            while ((match = regex.exec(sparql)) !== null) {
                const abbr = match[1];
                const id = match[2];
                sparql = sparql.replace(`${abbr}:${id}`, `<${prefixes[abbr]}${id}>`);
            }
        }
        return sparql.replace(/\s+/g, ' ').trim();
    }

    private _loadPatterns() {
        for (const [thingtalk, sparql] of Object.entries(patterns)) {
            const normalized = this._normalize(sparql);
            this._patterns.push({ thingtalk, sparql: normalized });
        }
    }
    
    match(code : string, pattern : string) : string[]|null {
        // make regex out of the pattern
        // replace(/[.*+?^${}()|[\]\\]/g, '\\$&'): escape special characters in pattern
        // replace(/\\\$[0-9]/g, '(Q[0-9]+)')): replace $? with regex for QID
        const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$[0-9]/g, '(Q[0-9]+)'));
        const match = regex.exec(code);
        if (!match) 
            return null;
        // the first match is the full code, the rest is the matching group, i.e., the QIDs
        return match.slice(1);
    }


    toSPARQL(thingtalk : string) : string|null {
        for (const pattern of this._patterns) {
            const match = this.match(thingtalk, pattern.thingtalk);
            let sparql = pattern.sparql;
            if (match) {
                for (let i = 0; i < match.length; i++) 
                    sparql = sparql.replace('$' + i, match[i]);
                return sparql;
            }
        }
        return null;
    }

    fromSPARQL(sparql : string) {
        for (const pattern of this._patterns) {
            const match = this.match(this._normalize(sparql), pattern.sparql);
            let thingtalk = pattern.thingtalk;
            if (match) {
                for (let i = 0; i < match.length; i++) 
                    thingtalk = thingtalk.replace('$' + i, match[i]);
                return thingtalk;
            }
        }
        return null;
    }
}