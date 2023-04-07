import { normalize } from '../../utils/sparqljs';

const patterns = {
    // what is XXX ? 
    '@wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". wd:$0 schema:description ?x. } 
    }`,

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
    }`,

    // when did X join league Y
    'min ( start_time of [ start_time of ( member_of_sports_team filter value == any ( @wd . entity ( ) filter contains ( league , " $1 " ^^wd:entity ) ) ) ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ) ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P54> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P54> ?y. 
        ?y <http://www.wikidata.org/prop/direct/P118> <http://www.wikidata.org/entity/$1>. 
        ?p pq:P580 ?x. 
    } ORDER BY ?x LIMIT 1`,

    // when did X leave league Y
    'max ( end_time of [ end_time of ( member_of_sports_team filter value == any ( @wd . entity ( ) filter contains ( league , " $1 " ^^wd:entity ) ) ) ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ) ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P54> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P54> ?y. 
        ?y <http://www.wikidata.org/prop/direct/P118> <http://www.wikidata.org/entity/$1>. 
        ?p pq:582 ?x. 
    } ORDER BY DESC(?x) LIMIT 1`,

    // who was the vp of X
    '@wd . entity ( ) filter contains ( position_held filter start_time == any ( [ start_time of ( position_held filter value == " Q11696 " ^^wd:p_position_held ) ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ) , " Q11699 " ^^wd:p_position_held ) ;':
    `SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/P39> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P39> <http://www.wikidata.org/entity/Q11699>; 
           <http://www.wikidata.org/prop/qualifier/P580> ?y. 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P39> ?q. 
        ?q <http://www.wikidata.org/prop/statement/P39> <http://www.wikidata.org/entity/Q11696>; 
           <http://www.wikidata.org/prop/qualifier/P580> ?z. 
        FILTER(?y = ?z) 
    }`,

    // WebQTrn-3551
    '@wd . human ( ) filter contains ( position_held filter point_in_time == any ( [ inception ] of @wd . organization ( ) filter id == " Q742787 " ^^wd:organization ) , " Q11696 " ^^wd:p_position_held ) ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/Q30> <http://www.wikidata.org/prop/P6> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P6> ?x; 
        <http://www.wikidata.org/prop/qualifier/P580> ?y; <http://www.wikidata.org/prop/qualifier/P582> ?z. 
        <http://www.wikidata.org/entity/Q742787> <http://www.wikidata.org/prop/direct/P571> ?w. 
        FILTER((?y < ?w) && (?z >= ?w)) }
    `,
};

// convert examples based on manual patterns 
export class PatternConverter {
    private _patterns : Array<{ thingtalk : string, sparql : string }>;

    constructor() {
        this._patterns = [];
        this._loadPatterns();
    }

    private _loadPatterns() {
        for (const [thingtalk, sparql] of Object.entries(patterns)) {
            const normalized = normalize(sparql);
            this._patterns.push({ thingtalk, sparql: normalized });
        }
    }
    
    match(code : string, pattern : string) : string[]|null {
        // make regex out of the pattern
        // replace(/[.*+?^${}()|[\]\\]/g, '\\$&'): escape special characters in pattern
        // replace(/\\\$[0-9]/g, '(Q[0-9]+)')): replace $? with regex for QID
        const regex = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$[0-9]/g, '(Q[0-9]+)') + '$');
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
            const match = this.match(normalize(sparql), pattern.sparql);
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