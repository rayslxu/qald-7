import { 
    ENTITY_PREFIX,
    PROPERTY_PREFIX,
    PROPERTY_PREDICATE_PREFIX,
    PROPERTY_QUALIFIER_PREFIX,
    PROPERTY_STATEMENT_PREFIX
} from '../../utils/wikidata';

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

    // who was the leader of X during wwii
    '':
    `PREFIX wd:  PREFIX wdt:  PREFIX p:  PREFIX ps:  PREFIX pq: 
    SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/P39> ?y. 
        ?y <http://www.wikidata.org/prop/statement/P39> <http://www.wikidata.org/entity/Q11696>; <http://www.wikidata.org/prop/qualifier/P580> ?z; <http://www.wikidata.org/prop/qualifier/P582> ?p. 
        <http://www.wikidata.org/entity/Q362> <http://www.wikidata.org/prop/direct/P580> ?w; <http://www.wikidata.org/prop/direct/P582> ?v. 
        FILTER(((?z >= ?w) && (?z <= ?v)) || ((?p >= ?w) && (?p <= ?v))) 
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

    // who did X sign with, who does X play for
    '[ member_of_sports_team ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE {
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/direct/P54> ?x. 
    }
    `,

    // who plays X in Y
    '[ cast_member filter character_role == " $0 " ^^wd:entity ] of @wd . entity ( ) filter id == " $1 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        ?y <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/$1>; <http://www.wikidata.org/prop/P725>|<http://www.wikidata.org/prop/P161> ?x. 
        ?x <http://www.wikidata.org/prop/statement/P725>|<http://www.wikidata.org/prop/statement/P161> <http://www.wikidata.org/entity/$0>. 
    }`,

    // what team did X play for in college
    '[ member_of_sports_team : Entity ( wd:college_sports_team ) ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/direct/P54> ?x. 
        ?x <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q18558301>. 
    }`,

    // what is the second biggest state in US
    'sort ( area desc of @wd . administrative_territorial_entity ( ) filter instance_of == " Q35657 " ^^wd:administrative_territorial_entity_subdomain ) [ 2 ] ;':
    `SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q107390>; <http://www.wikidata.org/prop/direct/P2046> ?y. 
    } ORDER BY DESC (?y) OFFSET 1 LIMIT 1`, 

    // what is the most populated state in united states
    'sort ( population desc of @wd . administrative_territorial_entity ( ) filter instance_of == " Q35657 " ^^wd:administrative_territorial_entity_subdomain ) [ 1 ] ;':
    `PREFIX wd:  PREFIX wdt:  
    SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q107390>; <http://www.wikidata.org/prop/direct/P1082> ?y. 
    } ORDER BY DESC (?y) LIMIT 1`,

    // who won the X in 2002
    '[ winner ] of @wd . entity ( ) filter instance_of == " $0 " ^^wd:domain && point_in_time < new Date ( 2003 ) && point_in_time >= new Date ( 2002 ) ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P1346> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P1346> ?x; <http://www.wikidata.org/prop/qualifier/P585> ?y. 
        FILTER((?y < "2003-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>) && (?y >= "2002-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>)) 
    }`,

    // what is X parents name, who are X's mom and dad
    '[ father , mother ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/direct/P22>|<http://www.wikidata.org/prop/direct/P25> ?x. 
    }`,

    // where do X people come from
    '@wd . country ( ) filter contains ( ethnic_group , " $0 " ^^wd:entity ) ;':
    `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/> 
    SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/direct/P495>|<http://www.wikidata.org/prop/direct/P66> ?x. 
    }`,

    // what degree did X get
    '[ educated_at . academic_degree ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P69> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P69> ?y; <http://www.wikidata.org/prop/qualifier/P512> ?x. 
        ?y <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q38723>. 
    }`,

    // where did X come from
    '[ place_of_birth ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/direct/P19> ?x. 
    }`,

    // where did X live
    '[ residence ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P551> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P551> ?x. 
    }`,

    // what state did X live
    '[ residence : Entity ( wd:federated_state ) ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `PREFIX wd:  PREFIX wdt:  
    SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/direct/P551> ?x. 
        ?x <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q35657>. 
    }`,

    // what year did X go to world series
    '[ point_in_time ] of @wd . entity ( ) filter contains ( participating_team , " $0 " ^^wd:entity ) && instance_of == " Q265538 " ^^wd:domain ;':
    `SELECT DISTINCT ?x WHERE { 
        ?y <http://www.wikidata.org/prop/direct/P3450> <http://www.wikidata.org/entity/Q265538>; <http://www.wikidata.org/prop/P1923> ?z; <http://www.wikidata.org/prop/direct/P585> ?x. 
        ?z <http://www.wikidata.org/prop/statement/P1923> <http://www.wikidata.org/entity/$0>. 
    }`,

    // when was the last time X won the world series
    '[ point_in_time ] of sort ( point_in_time desc of @wd . entity ( ) filter contains ( winner , " $0 " ^^wd:entity ) && instance_of == " Q265538 " ^^wd:domain ) [ 1 ] ;':
    `SELECT DISTINCT ?x WHERE { 
        ?p <http://www.wikidata.org/prop/direct/P3450> <http://www.wikidata.org/entity/Q265538>; <http://www.wikidata.org/prop/P1346> ?y; <http://www.wikidata.org/prop/direct/P585> ?x. 
        ?y <http://www.wikidata.org/prop/statement/P1346> <http://www.wikidata.org/entity/$0>. 
    } ORDER BY DESC (?x) LIMIT 1`,

    // what offices did X hold
    '[ position_held ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P39> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P39> ?x. ?x ((<http://www.wikidata.org/prop/direct/P31>*)/(<http://www.wikidata.org/prop/direct/P279>*)) <http://www.wikidata.org/entity/Q294414>. 
    }`,

    // who did X have affairs with, who has X dated
    '[ unmarried_partner ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P451>/<http://www.wikidata.org/prop/statement/P451> ?x. 
    }`,

    // what are the names of X movies in order ? 
    'sort ( publication_date asc of @wd . entity ( ) filter contains ( part_of_the_series , " $0 " ^^wd:entity ) ) ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P527> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P527> ?x; <http://www.wikidata.org/prop/qualifier/P580> ?y. 
    } ORDER BY ?y`,

    // what was the last movie X was in
    'sort ( publication_date asc of @wd . entity ( ) filter contains ( cast_member , " $0 " ^^wd:entity ) ) ;':
    `SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/direct/P31>/<http://www.wikidata.org/prop/direct/P279>* <http://www.wikidata.org/entity/Q11424>; <http://www.wikidata.org/prop/direct/P577> ?y; <http://www.wikidata.org/prop/P161> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P161> <http://www.wikidata.org/entity/$0>. 
    } ORDER BY DESC (?y) LIMIT 1`,

    // when did kaley cuoco join charmed
    '[ first_appearance ] of @wd . entity ( ) filter id == " Q16759 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        ?p <http://www.wikidata.org/prop/direct/P179> <http://www.wikidata.org/entity/Q162371>; <http://www.wikidata.org/prop/direct/P577> ?x; <http://www.wikidata.org/prop/P161> ?y. 
        ?y <http://www.wikidata.org/prop/statement/P161> <http://www.wikidata.org/entity/Q16759>. 
    } ORDER BY ?x LIMIT 1`,

    // when did X last win the Y champion
    '[ point_in_time ] of sort ( point_in_time desc of @wd . entity ( ) filter contains ( winner , " $0 " ^^wd:entity ) && instance_of == " $1 " ^^wd:domain ) [ 1 ] ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/Q11152> <http://www.wikidata.org/prop/P1346> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P1346> <http://www.wikidata.org/entity/Q1130849>; <http://www.wikidata.org/prop/qualifier/P585> ?x. 
    } ORDER BY DESC (?x) LIMIT 1`,

    // what was X's first team
    '[ drafted_by ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/Q36159> <http://www.wikidata.org/prop/P54> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P54> ?x; <http://www.wikidata.org/prop/qualifier/P580> ?y. 
    } ORDER BY ?y LIMIT 1`,

    // what was X's first album
    'sort ( publication_date asc of @wd . entity ( ) filter contains ( performer , " $0 " ^^wd:entity ) && instance_of == " Q482994 " ^^wd:domain ) [ 1 ] ;':
    `SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q482994>; <http://www.wikidata.org/prop/direct/P175> <http://www.wikidata.org/entity/Q2306>; <http://www.wikidata.org/prop/direct/P577> ?y. 
    } ORDER BY ?y LIMIT 1`,

    // what district does X represent
    '[ position_held . electoral_district ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P39> ?p. 
        ?p <http://www.wikidata.org/prop/qualifier/P580> ?z; <http://www.wikidata.org/prop/qualifier/P768> ?x. 
    } ORDER BY DESC (?z) LIMIT 1`,

    // who is X's quarterback
    '@wd . entity ( ) filter contains ( member_of_sports_team , " $0 " ^^wd:entity ) && contains ( position_played_on_team__speciality , " Q622747 " ^^wd:entity ) ;':
    `SELECT DISTINCT ?x WHERE { 
        ?x <http://www.wikidata.org/prop/direct/P413> <http://www.wikidata.org/entity/Q622747>; <http://www.wikidata.org/prop/P54> ?y. 
        ?y <http://www.wikidata.org/prop/statement/P54> <http://www.wikidata.org/entity/Q223243>; <http://www.wikidata.org/prop/qualifier/P580> ?z. 
    } ORDER BY DESC (?z) LIMIT 1`,

    // what country did X live in
    '[ country ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/Q37970> <http://www.wikidata.org/prop/P551> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P551> ?y. 
        ?y <http://www.wikidata.org/prop/direct/P17> ?x. 
    }`,

    // who originally voiced X on Y
    '[ voice_actor filter character_role == " $0 " ^^wd:entity ] of @wd . entity ( ) filter id == " $1 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        ?p <http://www.wikidata.org/prop/direct/P179> <http://www.wikidata.org/entity/$1>; wdt:P580 ?y. 
        ?p <http://www.wikidata.org/prop/direct/P527> ?z. 
        ?z <http://www.wikidata.org/prop/P725> ?w. 
        ?w <http://www.wikidata.org/prop/statement/P725> ?x; <http://www.wikidata.org/prop/qualifier/P453> <http://www.wikidata.org/entity/$0>. 
    } ORDER BY ?y LIMIT 1`,

    // what state was X from
    '[ < place_of_birth / located_in_the_administrative_territorial_entity > : Entity ( wd:federated_state ) ] of @wd . human ( ) filter id == " $0 " ^^wd:human ;':
    `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX p:  PREFIX ps:  PREFIX pq:  
    SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/Q76> <http://www.wikidata.org/prop/P19> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P19> ?y; <http://www.wikidata.org/prop/qualifier/P131> ?x. 
    }`,

    // which country was X born
    '[ country ] of @wd . entity ( ) filter in_array ( id , any ( [ place_of_birth ] of @wd . entity ( ) filter id == " $0 " ^^wd:entity ) ) ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P19> ?p. 
        ?p <http://www.wikidata.org/prop/qualifier/P131> ?x. 
        ?x <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/Q6256>. 
    }`,

    // where has the X language evolved from
    '[ subclass_of ] of @wd . entity ( ) filter id == " Q809 " ^^wd:entity ;':
    `SELECT DISTINCT ?x WHERE { 
        <http://www.wikidata.org/entity/$0> <http://www.wikidata.org/prop/P279> ?p. 
        ?p <http://www.wikidata.org/prop/statement/P279> ?x. 
    }`,

    // when was the last time the X went to the Y cup
    '[ point_in_time ] of @wd . entity ( ) filter contains ( participating_team , " $0 " ^^wd:entity ) && instance_of == " $1 " ^^wd:domain ;':
    `PREFIX wd:  PREFIX wdt:  PREFIX p:  PREFIX ps:  
    SELECT DISTINCT ?x WHERE { 
        ?p <http://www.wikidata.org/prop/direct/P31> <http://www.wikidata.org/entity/$1>; <http://www.wikidata.org/prop/direct/P585> ?x. 
        ?p <http://www.wikidata.org/prop/P1923> ?y. 
        ?y <http://www.wikidata.org/prop/statement/P1923> <http://www.wikidata.org/entity/$0>. 
    } ORDER BY DESC (?x) LIMIT 1`,

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