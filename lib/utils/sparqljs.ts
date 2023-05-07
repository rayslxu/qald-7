import assert from 'assert';
import {
    IriTerm, 
    VariableTerm, 
    PropertyPath,
    SelectQuery,
    AskQuery,
    Pattern,
    Grouping,
    Expression,
    Ordering,
    BgpPattern,
    FilterPattern,
    UnionPattern,
    ServicePattern,
    Triple,
    OperationExpression
} from 'sparqljs';
import { 
    isBasicGraphPattern, 
    isNamedNode, 
    isPropertyPath, 
    isSequencePropertyPath, 
    isUnaryPropertyPath, 
    isWikidataEntityNode, 
    isWikidataPropertyNode,
    isSelectQuery, 
    isFilterPattern,
    isUnionPattern,
    isWikidataLabelServicePattern,
    isOperationExpression,
    isVariable,
    isAggregateExpression
} from './sparqljs-typeguard';
import { 
    ABSTRACT_PROPERTIES, 
    PROPERTY_PREDICATE_PREFIX, 
    ENTITY_PREFIX, 
    PROPERTY_PREFIX, 
    PROPERTY_QUALIFIER_PREFIX, 
    PROPERTY_STATEMENT_PREFIX 
} from './wikidata';

/**
 * Given a parsed object returned by sparqljs, extract rdf triples out of it
 * @param obj any object containing 'triples' field at any depth
 * @returns a flattened array of triples 
 */
export function extractTriples(obj : any) : Triple[] {
    const triples : Triple[] = [];
    function extract(obj : any) {
        if (obj instanceof Object) {
            for (const [key, value] of Object.entries(obj)) {
                if (key === 'triples') {
                    const flattened = (value as any[]).flat(Infinity);
                    for (const triple of flattened)
                        triples.push(triple); 

                } else {
                    extract(value);
                }
            }
        }
    }
    extract(obj);
    return triples;
}

/**
 * Extract Wikidata properties involved in a predicate 
 * @param predicate A predicate form sparqljs
 * @returns a flattened array of Wikidata properties (E.g, [P31, P279, ...]) 
 */
export function extractProperties(predicate : IriTerm|PropertyPath|VariableTerm) : string[] {
    const properties : string[]= [];
    function extract(predicate : IriTerm|PropertyPath|VariableTerm) {
        if (isNamedNode(predicate)) {
            if (predicate.value.startsWith(PROPERTY_PREFIX)) 
                properties.push(predicate.value.slice(PROPERTY_PREFIX.length));
        } else if (isPropertyPath(predicate)) {
            // only extract the first item in the property path
            extract(predicate.items[0]);
        }
    }
    extract(predicate);
    return properties;
}


/**
 * Some heuristics to simplify the property path
 * The simplified version should not have any difference in semantics in natural language
 */
export function preprocessPropertyPath(predicate : IriTerm|PropertyPath|VariableTerm) : IriTerm|PropertyPath|VariableTerm {
    // property path
    if (!isPropertyPath(predicate))
        return predicate;
    if (predicate.pathType === '/') {
        // P31/P279* -> P31
        if (predicate.items.length === 2) {
            const [first, second] = predicate.items;
            if (isWikidataPropertyNode(first, 'P31') && 
                isUnaryPropertyPath(second, '*') && 
                isWikidataPropertyNode(second.items[0], 'P279'))
                return first;
        }
        predicate.items = predicate.items.map((item) => preprocessPropertyPath(item) as IriTerm|PropertyPath);
    } else if (predicate.pathType === '+') {
        assert(predicate.items.length === 1);
        const item = predicate.items[0];

        // P131+ -> P131
        if ('termType' in item) {
            if (isWikidataPropertyNode(item, 'P131')) 
                return item;
        }
    } else if (predicate.pathType === '|') {
        // handle all abstract properties
        for (const [abstract_property, { properties }] of Object.entries(ABSTRACT_PROPERTIES)) {
            for (const prefix of [PROPERTY_PREFIX, PROPERTY_PREDICATE_PREFIX, PROPERTY_STATEMENT_PREFIX, PROPERTY_QUALIFIER_PREFIX]) {
                if (predicate.items.every((p) => 'value' in p && properties.includes(p.value.slice(prefix.length)))) {
                    const simplified = predicate.items[0] as IriTerm;
                    simplified.value = prefix + abstract_property;
                    return simplified;
                }
            }
        }
    }    
    return predicate;
}

function isInstanceOf(triple : Triple) : boolean {
    const predicate = triple.predicate;
    if (isWikidataPropertyNode(predicate, 'P31'))
        return true;
    
    if (isSequencePropertyPath(predicate)) {
        if (predicate.items.length !== 2)
            return false;
        if (!isWikidataPropertyNode(predicate.items[0], 'P31'))
            return false;
        if (isUnaryPropertyPath(predicate.items[1], '*') && isWikidataPropertyNode(predicate.items[1].items[0], 'P279'))
            return true;
        return false;
    }

    return false;
}

/**
 * Handle a few special cases for union clause
 * @param predicate A predicate
 * @returns a parsed triple for the special cases, and false if not matched 
 */
export function preprocessSpecialUnion(union : UnionPattern) : Triple|false {
    const result = _preprocessUSStateSpecialUnion(union);
    if (result)
        return result;

    if (union.patterns.length !== 2)
        return false;
    if (!isBasicGraphPattern(union.patterns[0]) || !isBasicGraphPattern(union.patterns[1]))
        return false;
    if (union.patterns[0].triples.length !== 1 || union.patterns[1].triples.length !== 1)
        return false;
    const first = union.patterns[0].triples[0];
    const second = union.patterns[1].triples[0];
    if (!(first.subject.value && first.subject.value === second.subject.value))
        return false;
    if (!(first.object.value && first.object.value === second.object.value))
        return false;
    if (!isNamedNode(first.predicate))
        return false;
    if (!isSequencePropertyPath(second.predicate))
        return false;
    if (second.predicate.items.length !== 2)
        return false;
        
    // case 1: { ?s ?p ?o } union { ?s ?p/P17 ?o } ==> { ?s ?p ?o }
    if (isNamedNode(second.predicate.items[0]) && isNamedNode(second.predicate.items[1]) &&
        second.predicate.items[0].value === first.predicate.value &&
        isWikidataPropertyNode(second.predicate.items[1], 'P17')) // country
        return first;
    // case 2: { ?s P31 ?o } union { ?s P31/P279* ?o } ==> { ?s P31 ?o }
    if (isNamedNode(second.predicate.items[0]) && isUnaryPropertyPath(second.predicate.items[1], '*') &&
        second.predicate.items[0].value === first.predicate.value &&
        isWikidataPropertyNode(second.predicate.items[1].items[0], 'P279'))
        return first;
    return false;
}


// { ?s P31/P279* Q475050. } union { ?s P31/P279* Q107390 } => { ?s P31 Q107390 } 
// this includes DC when talking about states in united states
function _preprocessUSStateSpecialUnion(union : UnionPattern) : Triple|false {
    if (union.patterns.length !== 2)
        return false;
    
    let stateTriple, federalDistrictTriple;
    for (const pattern of union.patterns) {
        if (!isBasicGraphPattern(pattern))
            return false;
        if (pattern.triples.length !== 1)
            return false;
        const triple = pattern.triples[0];
        if (isInstanceOf(triple) && isWikidataEntityNode(triple.object, 'Q107390')) 
            stateTriple = triple;
        if (isInstanceOf(triple) && isWikidataEntityNode(triple.object, 'Q475050'))
            federalDistrictTriple = triple;
    }
    if (!stateTriple || !federalDistrictTriple)
        return false;
    if (stateTriple.subject.value !== federalDistrictTriple.subject.value)
        return false;
    return stateTriple;
}

export function normalize(sparql : string) : string {
    const prefixes : Record<string, string> = {
        'wd': ENTITY_PREFIX,
        'wdt': PROPERTY_PREFIX,
        'p': PROPERTY_PREDICATE_PREFIX,
        'pq': PROPERTY_QUALIFIER_PREFIX,
        'ps': PROPERTY_STATEMENT_PREFIX
    };
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
    sparql = sparql.replace('PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>', '').replace(/xsd:dateTime/g, '<http://www.w3.org/2001/XMLSchema#dateTime>');
    sparql = sparql.replace('PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>', '').replace(/rdfs:label/g, 'http://www.w3.org/2000/01/rdf-schema#label>');
    return sparql.replace(/\s+/g, ' ').trim();
}

export abstract class NodeVisitor {
    visit(node : SelectQuery|AskQuery) {
        for (const pattern of node.where ?? []) 
            this._visitPattern(pattern);
        if (isSelectQuery(node)) {
            for (const grouping of node.group ?? [])
                this._visitGrouping(grouping);
            for (const expression of node.having ?? [])
                this._visitExpression(expression);
            for (const ordering of node.order ?? [])
                this._visitOrdering(ordering);
        }
    }

    _visitPattern(node : Pattern) {
        if (isBasicGraphPattern(node))
            this._visitBgpPattern(node);
        else if (isFilterPattern(node)) 
            this._visitFilterPattern(node);
        else if (isUnionPattern(node)) 
            this._visitUnionPattern(node);
        else if (isWikidataLabelServicePattern(node))
            this._visitWikidataLabelServicePattern(node);

        return true;
    }

    _visitGrouping(node : Grouping) {
        this._visitExpression(node.expression);
        return true;
    }

    _visitExpression(node : Expression) {
        if (isAggregateExpression(node)) {
            this._visitExpression(node.expression);
        } else if (isBasicGraphPattern(node)) {
            this._visitBgpPattern(node);
        } else if (isVariable(node)) {
            this._visitVariable(node);
        } else if (isOperationExpression(node)) {
            if (node.operator === '!')
                this._visitExpression(node.args[0] as OperationExpression);
            else if (node.operator === '||' || node.operator === '&&')
                node.args.forEach((exp) => this._visitExpression(exp as OperationExpression));
            else if (node.args.length === 1)
                this._visitUnaryOperation(node);
            else if (node.args.length === 2)
                this._visitBinaryOperation(node);
        } else {
            throw new Error(`Unsupported: non-operation expression: ${node}`);
        }
        return true;
    }

    _visitOrdering(node : Ordering) {
        this._visitExpression(node.expression);
        return true;
    }

    _visitBgpPattern(node : BgpPattern) {
        for (const triple of node.triples) 
            this._visitTriple(triple);
        return true;
    }

    _visitFilterPattern(node : FilterPattern) {
        this._visitExpression(node.expression);
        return true;
    }

    _visitUnionPattern(node : UnionPattern) {
        for (const pattern of node.patterns) {
            assert(isBasicGraphPattern(pattern));
            this._visitBgpPattern(pattern);
        }
        return true;
    }

    _visitWikidataLabelServicePattern(node : ServicePattern) {
        return true;
    }

    _visitTriple(node : Triple) {
        return true;
    }

    _visitUnaryOperation(node : OperationExpression) {
        return true;
    }

    _visitBinaryOperation(node : OperationExpression) {
        return true;
    }

    _visitVariable(node : VariableTerm) {
        return true;
    }
}

export class PreprocessVisitor extends NodeVisitor {
    _visitUnionPattern(node : UnionPattern|BgpPattern) {
        const triple = preprocessSpecialUnion(node as UnionPattern);
        if (triple) {
            this._visitTriple(triple);
            node.type = 'bgp';
            (node as BgpPattern).triples = [triple];
        }
        return true;
    }

    _visitTriple(node : Triple) {
        node.predicate =  preprocessPropertyPath(node.predicate);
        return true;
    }
}


export class PropertyPathFinder extends NodeVisitor {
    variableUsageCount : Record<string, { subject : number, object : number, other : number }>
    variableSubjectTriple : Record<string, Triple>;

    constructor() {
        super();
        this.variableUsageCount = {};
        this.variableSubjectTriple = {};
    }

    _add(variable : string, part : 'subject'|'object'|'other', triple ?: Triple) {
        if (!(variable in this.variableUsageCount))
            this.variableUsageCount[variable] = { subject: 0, object: 0, other: 0 };
        this.variableUsageCount[variable][part] += 1;

        if (part === 'subject')
            this.variableSubjectTriple[variable] = triple!;
    }

    _visitTriple(node : Triple) {
        const parts : Array<'subject'|'object'> = ['subject', 'object'];
        for (const part of parts) {
            if (isVariable(node[part])) {
                if (isWikidataPropertyNode(node.predicate) && !isWikidataPropertyNode(node.predicate, 'P31'))
                    this._add(node[part].value, part, node);
                else 
                    this._add(node[part].value, 'other'); // if it's not simple triple, count as other and do not optimize
            }
        }
        return true;
    }

    _visitUnaryOperation(node : OperationExpression) {
        if (isVariable(node.args[0]))
            this._add(node.args[0].value, 'other');
        return true;
    }

    _visitBinaryOperation(node : OperationExpression) {
        if (isVariable(node.args[0]))
            this._add(node.args[0].value, 'other');
        if (isVariable(node.args[1]))
            this._add(node.args[1].value, 'other');
        return true;
    }

    _visitVariable(node : VariableTerm) {
        this._add(node.value, 'other');
        return true;
    }
    
}

export class PropertyPathOptimizer extends NodeVisitor {
    variableSubjectTriple : Record<string, Triple>;

    constructor(variableSubjectTriple : Record<string, Triple>) {
        super();
        this.variableSubjectTriple = variableSubjectTriple;
    }

    _visitBgpPattern(node : BgpPattern) {
        const triples = [];
        for (const triple of node.triples) {
            if (this._visitTriple(triple))
                triples.push(triple);
        }
        node.triples = triples;
        return true;
    }

    _visitTriple(node : Triple) {
        if (isVariable(node.subject) && node.subject.value in this.variableSubjectTriple)
            return false;
        
        if (isVariable(node.object) && node.object.value in this.variableSubjectTriple) {
            const subquery = this.variableSubjectTriple[node.object.value];
            assert(isWikidataPropertyNode(node.predicate) && isWikidataPropertyNode(subquery.predicate));
            // change node to a property path triple
            node.object = subquery.object;
            node.predicate = {
                type: 'path',
                pathType: '/',
                items: [node.predicate, subquery.predicate]
            };
        } 
        return true;
    }
}