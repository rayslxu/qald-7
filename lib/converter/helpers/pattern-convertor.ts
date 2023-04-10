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
    
    // WebQTrn-598
    // who are the senator from XXX (state) in 2010 ?
    '@wd . entity ( ) filter contains ( position_held filter ( contains ( < electoral_district / located_in_the_administrative_territorial_entity > , " $0 " ^^wd:p_located_in_the_administrative_territorial_entity ) && point_in_time == new Date ( 2010 ) ) , " Q4416090 " ^^wd:p_position_held ) ;':
    `SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/P39> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P39> <http://www.wikidata.org/entity/Q4416090>; 
           <http://www.wikidata.org/prop/qualifier/P768> ?w; 
           <http://www.wikidata.org/prop/qualifier/P580> ?y; 
           <http://www.wikidata.org/prop/qualifier/P582> ?z. 
        ?w <http://www.wikidata.org/prop/direct/P131> <http://www.wikidata.org/entity/$0>. 
        FILTER((?y < "2011-01-01T00:00:00Z"^^xsd:dateTime) && (?z >= "2010-01-01T00:00:00Z"^^xsd:dateTime)) 
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

    // WebQTrn-411
    /// who is the first president of XXX -> this is normalized to use head of government / head of state depending on the country
    // TODO: add support to sort values of a property
    '[ head_of_state ] of ( sort ( head_of_state . start_time asc of @wd . country ( ) filter id == " $0 " ^^wd:country ) ) [ 1 ] ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P35> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P35> ?x; 
           <http://www.wikidata.org/prop/qualifier/P580> ?y.  
    } ORDER BY ?y LIMIT 1`,

    // WebQTrn-866
    // TODO: add support to sort values of a property 
    '[ spouse ] of ( sort ( spouse . start_time asc of @wd . entity ( ) filter id == " $0 " ^^wd:entity ) ) [ 1 ] ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P26> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P26> ?x; 
           <http://www.wikidata.org/prop/qualifier/P580> ?y. 
    } ORDER BY ?y LIMIT 1`,

    // WebQTrn-1731
    '[ object_has_role of has_parts filter value == " $0 " ^^wd:p_has_parts ] of @wd . entity ( ) filter id == " $1 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$1> <http://www.wikidata.org/prop/P527> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P527> <http://www.wikidata.org/entity/$0>; 
           <http://www.wikidata.org/prop/qualifier/P3831> ?x. 
    }`
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