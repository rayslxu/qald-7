import assert from 'assert';
import { EntityUtils } from 'genie-toolkit';
import ThingTalk, { Type } from 'thingtalk';
import { Ast, Syntax } from "thingtalk";
import WikidataUtils, { ABSTRACT_PROPERTIES } from '../utils/wikidata';
import { 
    ENTITY_PREFIX, 
    PROPERTY_PREFIX, 
    LABEL, 
    DATETIME, 
    TP_DEVICE_NAME,
    PROPERTY_PREDICATE_PREFIX,
    PROPERTY_QUALIFIER_PREFIX,
    PROPERTY_STATEMENT_PREFIX
} from '../utils/wikidata';
import { PatternConverter } from './helpers/pattern-convertor';
import { RuleBasedPreprocessor } from './helpers/rule-based-preprocessor';

const ENTITY_VARIABLES = ['x', 'y', 'z', 'w'];
const PREDICATE_VARIABLES = ['p', 'q', 'r'];

function isVariable(node : string) {
    const regex = new RegExp(`^(${[...ENTITY_VARIABLES, ...PREDICATE_VARIABLES].join('|')})[0-9]*$`);
    return regex.test(node);
}

function convertOp(op : string) {
    // HACK
    return ['>=', '<='].includes(op) ? op[0] : op; 
}

// HACK: replace domain with other domain due to wikidata artifacts
const DOMAIN_MAP : Record<string, string> = {
    // replace "book" to "literary work", as book is not commonly used in wikidata
    'Q571': 'Q7725634'
};

interface TripleOptions {
    type : 'direct'|'predicate'|'qualifier'|'statement',
    availableProperties ?: string[],
}

class TableInfoVisitor extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    subject ?: string;
    mainDomain ?: string; // main domain
    domainNames : string[]; // find all non-qid domain names (including main domain and projection type constraints) so we can get their qids ahead of time

    constructor(converter : ThingTalkToSPARQLConverter) {
        super();
        this._converter = converter;
        this.domainNames = [];
    }

    visitChainExpression(node : ThingTalk.Ast.ChainExpression) : boolean {
        if (node.expressions.length > 1)   
            throw new Error(`Not supported: chain expression`);
        return true;
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        if (node.name === 'id' && node.value instanceof Ast.EntityValue)
            this.subject = `<${ENTITY_PREFIX}${node.value.value}>`;
        if (node.name === 'instance_of' && node.value instanceof Ast.EntityValue) 
            this.mainDomain = node.value.value!;
        return true;
    }

    visitInvocation(node : ThingTalk.Ast.Invocation) : boolean {
        if (node.channel !== 'entity') {
            if (this._converter.humanReadableInstanceOf) {
                this.mainDomain = node.channel.replace(/_/g, ' ');
                this.domainNames.push(this.mainDomain);
            } else {
                const query = this._converter.class.getFunction('query', node.channel);
                if (!query) 
                    throw new Error('Unknown query domain: ' + node.channel);
                this.mainDomain = (query.getImplementationAnnotation('wikidata_subject') as string[])[0];
            } 
        }
        return true;
    }

    visitComparisonSubqueryBooleanExpression(node : ThingTalk.Ast.ComparisonSubqueryBooleanExpression) : boolean {
        return false;
    }

    visitProjectionExpression2(node : ThingTalk.Ast.ProjectionExpression2) : boolean {
        for (const proj of node.projections) {
            for (const type of proj.types) {
                if (type instanceof Type.Entity)
                    this.domainNames.push(type.type.slice(TP_DEVICE_NAME.length + 1).replace(/_/g, ' '));
            }
        }
        return true;
    }
}

interface QualifiedPredicate {
    property : string;
    predicateVariable : string;
}


class TripleGenerator extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    private _subject : string;
    private _subjectProperties : string[]; 
    private _target_projection : string|null;
    private _inPredicate : QualifiedPredicate|null;
    private _statements : string[];

    constructor(converter : ThingTalkToSPARQLConverter, 
                subject : string, 
                subjectProperties : string[], // list properties available for the subject 
                projection : string|null, 
                domain : string|null,
                qualifiedPredicate : QualifiedPredicate|null = null) {
        super();
        this._converter = converter;
        this._subject = subject; // either a variable with ? prefix, or a full path QID
        this._subjectProperties = subjectProperties;
        this._target_projection = projection;
        this._inPredicate = qualifiedPredicate;
        this._statements = [];
        if (isVariable(subject) && domain)
            this._statements.push(this._triple(subject, 'P31', domain));
    }

    get statements() : string[] {
        return this._statements;
    }

    private _node(node : string) : string {
        if (isVariable(node))
            return '?' + node;
        if (this._converter.kb.isEntity(node))
            return `<${ENTITY_PREFIX}${node}>`;
        assert(node.startsWith(`<${ENTITY_PREFIX}`));
        return node;
    }

    private _edge(property : string, value : string, options : TripleOptions = { type: 'direct' }) : string {
        for (const sep of ['|', '/']) {
            if (property.includes(sep))
                return property.split(sep).map((p) => this._edge(p, value, options)).join(sep);
        }
        let prefix;
        if (this._inPredicate) {
            if (property === 'value') {
                property = this._inPredicate.property;
                prefix = PROPERTY_STATEMENT_PREFIX;
            } else {
                prefix = PROPERTY_QUALIFIER_PREFIX;
            }
        } else {
            switch (options.type) {
            case 'predicate':
                prefix = PROPERTY_PREDICATE_PREFIX;
                break;
            case 'qualifier':
                prefix = PROPERTY_QUALIFIER_PREFIX;
                break;
            case 'statement':
                prefix = PROPERTY_STATEMENT_PREFIX;
                break;
            default:
                prefix = PROPERTY_PREFIX;
            }
        }

        const predicate = `<${prefix}${property}>`;

        // SPECIAL CASES: 
        // P131, located in admin entity
        // P361. part of  
        // always do property path "+"
        if (property === 'P131' || property === 'P361')
            return predicate + '+';
        // P31, instance of, always add optional subclass of
        if (property === 'P31')
            return `<${prefix}P31>/<${prefix}P279>*`;
        return predicate;
    }

    private _triple(subject : string, property : string, value : string, options ?: TripleOptions) {
        const s = this._node(subject);
        const p = this._edge(property, value, options);
        const v = this._node(value);

        if (property === 'P31' && value === 'Q107390')
            return `{ ${s} ${p} ${v}. } UNION { ${s} ${p} ${this._node('Q475050')}. }`;
        if (property === 'P31' && value in DOMAIN_MAP)
            value = DOMAIN_MAP[value];
        return `${s} ${p} ${v}.`;
    }

    private _add(subject : string, property : string, operator : string, value : Ast.Value|string, options ?: TripleOptions) {
        const type = options?.type ?? 'direct';
        const availableProperties = options?.availableProperties ?? (subject === this._subject ? this._subjectProperties : []);
        options = { type, availableProperties };

        // if value is an variable
        if (typeof value === 'string') {
            assert(isVariable(value) && ['==', 'contains', 'in_array'].includes(operator));
            const p = this._converter.getWikidataProperty(property);
            if (p === undefined)
                throw new Error('Unknown property: ' + property);
            if (p in ABSTRACT_PROPERTIES) {
                if (ABSTRACT_PROPERTIES[p].type === 'all') {
                    const realProperties = ABSTRACT_PROPERTIES[p].properties;
                    this._statements.push(this._triple(subject, realProperties.join('|'), value, options));
                } else {
                    const variables = [];
                    const availableRealProperties = ABSTRACT_PROPERTIES[p].properties.filter((rp) => availableProperties.includes(rp));
                    // if there is no properties available, return the abstract property, it probably won't return anything anyway 
                    if (availableRealProperties.length === 0) {
                        this._statements.push(this._triple(subject, p, value, options));
                    } else if (availableRealProperties.length === 1) {
                        this._statements.push(this._triple(subject, availableRealProperties[0], value, options));
                    } else {
                        for (const [i, realProperty] of Object.entries(ABSTRACT_PROPERTIES[p].properties)) {
                            const variable = value + i;
                            variables.push(variable);
                            this._statements.push(`OPTIONAL { ${this._triple(subject, realProperty, variable, options)} }`);
                        }
                        this._statements.push(`BIND(COALESCE(${variables.map((v) => `?${v}`).join(', ')}) AS ?${value}).`);
                    }
                }
            } else {
                this._statements.push(this._triple(subject, p, value, options));
            }
            return;
        }

        // if value is a non-variable 
        // id string filter
        if (property === 'id' && operator === '=~') {
            assert(value instanceof Ast.StringValue);
            const variable = this._converter.getEntityVariable();
            this._statements.push(`${this._node(subject)} <${LABEL}> ?${variable}.`);
            this._statements.push(`FILTER(LCASE(STR(?${variable})) = "${value.value}").`);
            return;
        }

        // skip all other filters on id and instance_of
        if (property === 'id' || property === 'instance_of')
            return;

        // filter on aggregation result
        if (property === 'count') {
            assert(value instanceof Ast.NumberValue);
            // check if any node satisfying the filters exists, no need to do anything
            if (value.value === 1 && operator === '>=')
                return;
            throw new Error('Unsupported aggregation');
        } 

        const p = property === 'value' && this._inPredicate ? property : this._converter.getWikidataProperty(property);
        if (p === undefined)
            throw new Error('Unknown property: ' + property);

        // filter on point in time 
        if (p === 'P585') {
            assert(value instanceof Ast.DateValue && value.value instanceof Date);
            const date = new Date(value.value);
            if (operator === '==' && date.getUTCMonth() === 0 && date.getUTCDate() === 1) {
                const beginValue = `"${date.toISOString()}"^^<${DATETIME}>`;
                date.setUTCFullYear(date.getUTCFullYear() + 1);
                const endValue = `"${date.toISOString()}"^^<${DATETIME}>`;
                // if (this._subject.startsWith('?')) 
                //    throw Error('TODO: generic filter on time for search questions');
                if (availableProperties.includes('P580')) {
                    const variable1 = this._converter.getEntityVariable('P580');
                    this._statements.push(this._triple(subject, 'P580', variable1, options));
                    const variable2 = this._converter.getEntityVariable('P582');
                    this._statements.push(this._triple(subject, 'P582', variable2, options));
                    this._statements.push(`FILTER((?${variable1} <= ${endValue}) && (?${variable2} >= ${beginValue}))`);
                } else {
                    const variable = this._converter.getEntityVariable('P585');
                    this._statements.push(this._triple(subject, 'P585', variable, options));
                    this._statements.push(`FILTER((?${variable} >= ${beginValue}) && (?${variable} <= ${endValue}))`);
                }
                return;
            }
        } else if (p in ABSTRACT_PROPERTIES) {
            assert(value instanceof Ast.EntityValue && ['==', 'contains', 'in_array'].includes(operator));
            const type = ABSTRACT_PROPERTIES[p].type;
            if (type === 'any') {
                for (const realProperty of ABSTRACT_PROPERTIES[p].properties) {
                    if (availableProperties.includes(realProperty)) {
                        this._statements.push(this._triple(subject, property, value.value!));
                        return;
                    }
                }
            } else {
                const or = [];
                for (const realProperty of ABSTRACT_PROPERTIES[p].properties) {
                    if (availableProperties.includes(realProperty)) 
                        or.push(realProperty);
                }
                if (or.length === 1)
                    this._statements.push(this._triple(subject, or[0], value.value!));
                else 
                    this._statements.push(this._triple(subject, or.join('|'), value.value!));
            }
            // no real properties found, return the abstract property
            this._statements.push(this._triple(subject, p, value.value!));
            return;
        }

        // generic atom filters 
        if (value instanceof Ast.EntityValue) {
            this._statements.push(this._triple(subject, p, value.value!, options));
        } else if (value instanceof Ast.NumberValue) {
            const variable = this._converter.getEntityVariable(p);
            this._statements.push(this._triple(subject, p, variable, options));
            this._statements.push(`FILTER(?${variable} ${convertOp(operator)} ${value.value}).`);
        } else if (value instanceof Ast.DateValue) {
            const date = (value.toJS() as Date).toISOString();
            const variable = this._converter.getEntityVariable(p);
            this._statements.push(this._triple(subject, p, variable, options));
            this._statements.push(`FILTER(?${variable} ${convertOp(operator)} "${date}"^^<${DATETIME}>).`);
        } else if (value instanceof Ast.StringValue) {
            const str = value.value;
            const variable = this._converter.getEntityVariable(p);
            this._statements.push(this._triple(subject, p, variable, options));
            this._statements.push(`?${variable} <${LABEL}> "${str}"@en.`);
        } else if (value instanceof Ast.EnumValue) {
            if (value.value === 'male')
                this._statements.push(this._triple(subject, p, 'Q6581097', options));
            else if (value.value === 'female')
                this._statements.push(this._triple(subject, p, 'Q6581072', options));
            else
                throw new Error('Unsupported enum value: ' + value);
        } else {
            throw new Error('Unsupported atom filter');
        }
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        assert(node.args.length > 0 || node.computations.length === 1);
        if (node.args.length === 1) {
            const arg = node.args[0];
            if (arg === 'id')
                return true;
            if (arg.includes('.')) {
                const [property, qualifier] = arg.split('.');
                const predicate = this._converter.getWikidataProperty(property);
                const availableProperties = this._subjectProperties.filter((p) => {
                    return p.startsWith(predicate + '.');
                }).map((p) => {
                    return p.slice(predicate.length + 1);
                });
                const predicateVariable = this._converter.getPredicateVariable();
                const valueVariable = this._converter.getEntityVariable();
                if (arg === this._target_projection) 
                    this._converter.setResultVariable(valueVariable);
                this._add(this._subject, property, '==', predicateVariable, { type: 'predicate' });
                this._add(predicateVariable, qualifier, '==', valueVariable, { type: 'qualifier', availableProperties });
            } else {
                const p = this._converter.getWikidataProperty(arg);
                const v = this._converter.getEntityVariable(p);
                if (arg === this._target_projection) 
                    this._converter.setResultVariable(v);
                this._add(this._subject, arg, '==', v);
            }
        } else if (node.args.length > 1) { 
            assert(this._target_projection && this._target_projection.split('|').length > 0);
            const targetProjections = this._target_projection?.split('|');
            const properties = [];
            for (const arg of node.args) {
                assert(targetProjections.includes(arg));
                properties.push(this._converter.getWikidataProperty(arg));
            } 
            const v = this._converter.getEntityVariable();
            this._converter.setResultVariable(v);
            this._statements.push(`${this._node(this._subject)} ${properties.map((p) => `<${PROPERTY_PREFIX}${p}>`).join('|')} ${this._node(v)}.`);
        } else {
            const computation = node.computations[0];
            if (computation instanceof Ast.FilterValue) {
                if (!(computation.filter instanceof Ast.ComparisonSubqueryBooleanExpression))
                    return true;
                if (!(computation.filter.lhs instanceof Ast.VarRefValue && computation.filter.lhs.name === 'value'))
                    return true;
                assert(computation.value instanceof Ast.VarRefValue);
                const p = this._converter.getWikidataProperty(computation.value.name);
                const v = this._converter.getEntityVariable(p);
                this._add(this._subject, computation.value.name, '==', v);
                const tripleGenerator = new TripleGenerator(this._converter, v, this._subjectProperties, null, null, null);
                computation.filter.visit(tripleGenerator);
                this._statements.push(...tripleGenerator.statements);

                if (computation.prettyprint() === this._target_projection)
                    this._converter.setResultVariable(v);
                return false;
            }
        }
        return true;
    }

    visitProjectionExpression2(node : ThingTalk.Ast.ProjectionExpression2) : boolean {
        assert(node.projections.length === 1);
        const proj = node.projections[0];
        if (proj.value instanceof Ast.Value)    
            throw new Error('Not supported: value in projection');
        
        const v = this._converter.getEntityVariable(proj.prettyprint());
        if (proj.prettyprint() === this._target_projection)
            this._converter.setResultVariable(v);
        
        if (Array.isArray(proj.value)) {
            const path : string[] = [];
            for (const elem of proj.value) {
                const p = this._converter.getWikidataProperty(elem.property);
                path.push(elem.quantifier ? `<${PROPERTY_PREFIX}${p}>${elem.quantifier}` : this._edge(p, v));
            }
            this._statements.push(`${this._node(this._subject)} ${path.join('/')} ?${v}.`);
        } else {
            this._add(this._subject, proj.value, '==', v);
        }     

        if (proj.types.length > 0) {
            const statements = proj.types.map((t) => {
                const type = (t as Type.Entity).type.slice(TP_DEVICE_NAME.length + 1).replace(/_/g, ' ');
                const domain = this._converter.getWikidataDomain(type)!;
                return this._triple(v, 'P31', domain);
            });
            if (statements.length === 1)
                this._statements.push(statements[0]);
            else 
                this._statements.push(`{ ${statements.join(' UNION ')} }`);
        }
        return true;
    }

    visitBooleanQuestionExpression(node : ThingTalk.Ast.BooleanQuestionExpression) : boolean {
        this._converter.setIsBooleanQuestion();
        return true;
    }

    visitNotBooleanExpression(node : ThingTalk.Ast.NotBooleanExpression) : boolean {
        if (node.expr instanceof Ast.AtomBooleanExpression) {
            if (node.expr.operator === '==' && node.expr.value instanceof Ast.NullValue) {
                const property = node.expr.name;
                const p = this._converter.getWikidataProperty(property);
                const v = this._converter.getEntityVariable(p);
                this._add(this._subject, property, '==', v);
                return false; 
            } 
        }
        throw new Error('Unsupported negative boolean expression');
    }

    visitOrBooleanExpression(node : ThingTalk.Ast.OrBooleanExpression) : boolean {
        const operands = [];
        for (const booleanExpression of node.operands) {
            const tripleGenerator = new TripleGenerator(this._converter, this._subject, this._subjectProperties, null, null);
            booleanExpression.visit(tripleGenerator);
            operands.push('{ ' + tripleGenerator.statements.join(' ') + ' }'); 
        }
        this._statements.push(operands.join(' UNION '));
        return false;     
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        this._add(this._subject, node.name, node.operator, node.value);
        return true;
    }

    visitComputeBooleanExpression(node : ThingTalk.Ast.ComputeBooleanExpression) : boolean {
        if (node.lhs instanceof Ast.Value.Computation) {
            if (node.lhs.op === 'count') {
                const property = (node.lhs.operands[0] as Ast.VarRefValue).name;
                const p = this._converter.getWikidataProperty(property);
                const op = convertOp(node.operator); 
                const value = (node.rhs as Ast.NumberValue).value;
                const variable = this._converter.getEntityVariable(p);
                this._add(this._subject, property, '==', variable);
                if (!(node.operator === '>=' && value === 1)) // this means it is just checking if anything exists, no need to use having clause
                    this._converter.addHaving(`COUNT(?${variable}) ${op} ${value}`);
                return true;
            }
        } else if (node.lhs instanceof Ast.Value.Filter) {
            const property = (node.lhs.value as Ast.VarRefValue).name;
            const predicate = this._createQualifiedPredicate(property);
            assert(node.operator === 'contains' || node.operator === '==');
            // update subject properties to qualifiers of the predicate
            const availableProperties = this._subjectProperties.filter((p) => {
                return p.startsWith(predicate.property + '.');
            }).map((p) => {
                return p.slice(predicate.property.length + 1);
            });
            this._add(predicate.predicateVariable, property, node.operator, node.rhs, { availableProperties, type: 'statement' });
            const tripleGenerator = new TripleGenerator(this._converter, predicate.predicateVariable, availableProperties, null, null, predicate);
            node.lhs.filter.visit(tripleGenerator);
            this._statements.push(...tripleGenerator.statements);  
            return true; 
        }
        throw new Error('Unsupported compute boolean expression: ' + node.prettyprint());
    }

    visitIndexExpression(node : ThingTalk.Ast.IndexExpression) : boolean {
        assert(node.indices.length === 1);
        this._converter.setLimit(1);
        const limit = (node.indices[0] as Ast.NumberValue).value;
        if (limit !== 1)
            this._converter.setOffset(limit - 1);
        return true;
    }

    visitSliceExpression(node : ThingTalk.Ast.SliceExpression) : boolean {
        const base = (node.base as Ast.NumberValue).value;
        const limit = (node.limit as Ast.NumberValue).value;
        this._converter.setLimit(limit - base + 1);
        if (base !== 1)
            this._converter.setOffset(base - 1);
        return true;
    }

    visitSortExpression(node : ThingTalk.Ast.SortExpression) : boolean {
        const property = (node.value as Ast.VarRefValue).name;
        const p = this._converter.getWikidataProperty(property);
        const variable = this._converter.getEntityVariable(p);
        this._add(this._subject, property, '==', variable);
        this._converter.setOrder({ variable : '?' + variable, direction: node.direction });
        return true;
    }

    visitAggregationExpression(node : ThingTalk.Ast.AggregationExpression) : boolean {
        if (node.operator === 'count' && node.field === '*') {
            this._converter.setAggregation(node.operator, this._subject);
        } else {
            const property = this._converter.getWikidataProperty(node.field);
            const v = this._converter.getEntityVariable(property);
            this._converter.setAggregation(node.operator, v);
            this._add(this._subject, node.field, '==', v);
        }
        return true;
    }

    visitPropertyPathBooleanExpression(node : ThingTalk.Ast.PropertyPathBooleanExpression) : boolean {
        const v = (node.value as Ast.EntityValue).value!;
        const predicate = node.path.map((elem) => {
            const p = this._converter.getWikidataProperty(elem.property);
            return elem.quantifier ? `<${PROPERTY_PREFIX}${p}>${elem.quantifier}` : this._edge(p, v);
        }).join('/'); 
        this._statements.push(`${this._node(this._subject)} ${predicate} ${this._node(v)}.`);
        return true;
    }

    // qualifier
    visitFilterValue(node : ThingTalk.Ast.FilterValue) : boolean {
        assert(node.value instanceof Ast.VarRefValue);
        const predicate = this._createQualifiedPredicate(node.value.name);
        const entityVariable = this._converter.getEntityVariable();
        this._add(predicate.predicateVariable, node.value.name, '==', entityVariable, { type: 'statement' });
        // update subject properties to qualifiers of the predicate
        const subjectProperties = this._subjectProperties.filter((p) => {
            return p.startsWith(predicate.property + '.');
        }).map((p) => {
            return p.slice(predicate.property.length + 1);
        });
        const tripleGenerator = new TripleGenerator(this._converter, predicate.predicateVariable, subjectProperties, null, null, predicate);
        node.filter.visit(tripleGenerator);
        this._statements.push(...tripleGenerator.statements);

        if (node.prettyprint() === this._target_projection)
            this._converter.setResultVariable(entityVariable);
        return false;
    }

    visitArrayFieldValue(node : ThingTalk.Ast.ArrayFieldValue) : boolean {
        assert(node.value instanceof Ast.FilterValue && node.value.value instanceof Ast.VarRefValue);
        const predicate = this._createQualifiedPredicate(node.value.value.name);
        let fieldVariable;
        if (typeof node.field === 'string') {
            const field = this._converter.getWikidataProperty(node.field);
            fieldVariable = this._converter.getEntityVariable(field);
            this._add(predicate.predicateVariable, node.field, '==', fieldVariable, { type: 'qualifier' });
        } else {
            fieldVariable = this._converter.getEntityVariable();
            const path = [];
            assert(!node.field[0].quantifier);
            path.push(`<${PROPERTY_QUALIFIER_PREFIX}${this._converter.getWikidataProperty(node.field[0].property)}>`);
            node.field.slice(1).forEach((elem) => {
                const p = this._converter.getWikidataProperty(elem.property);
                path.push('/');
                path.push(elem.quantifier ? `<${PROPERTY_PREFIX}${p}>${elem.quantifier}` : `<${PROPERTY_PREFIX}${p}>`);
            });
            this._statements.push(`?${predicate.predicateVariable} ${path.join('')} ?${fieldVariable}.`);
        }
        // update subject properties to qualifiers of the predicate
        const subjectProperties = this._subjectProperties.filter((p) => {
            return p.startsWith(predicate.property + '.');
        }).map((p) => {
            return p.slice(predicate.property.length + 1);
        });
        
        const tripleGenerator = new TripleGenerator(this._converter, predicate.predicateVariable, subjectProperties, null, null, predicate);
        node.value.filter.visit(tripleGenerator);
        this._statements.push(...tripleGenerator.statements);

        if (node.prettyprint() === this._target_projection)
            this._converter.setResultVariable(fieldVariable);
        return false;
    }

    private _createQualifiedPredicate(property : string) : QualifiedPredicate {
        const p = this._converter.getWikidataProperty(property);
        const predicateVariable = this._converter.getPredicateVariable();
        this._add(this._subject, property, '==', predicateVariable, { type: 'predicate' });
        return {
            property : p,
            predicateVariable
        };
    }

    visitComparisonSubqueryBooleanExpression(node : ThingTalk.Ast.ComparisonSubqueryBooleanExpression) : boolean {
        assert(node.lhs instanceof Ast.VarRefValue);

        let filterVariable;
        if (node.lhs.name === 'id' || node.lhs.name === 'value') {
            filterVariable = this._subject;
        } else {
            const filterProperty = this._converter.getWikidataProperty(node.lhs.name);
            filterVariable = this._converter.getEntityVariable(filterProperty);
            this._add(this._subject, node.lhs.name, '==', filterVariable);
        }

        // set variable map for the subquery (do not use existing mapping)
        const variableMap : Record<string, string> = {};
        let projection  = node.rhs instanceof Ast.ProjectionExpression ? node.rhs.args[0] : 'id';
        if (projection === 'id') {
            variableMap[projection] = filterVariable;
        } else {
            projection = this._converter.getWikidataProperty(projection);
            if (node.lhs.name === 'id')
                variableMap[projection] = filterVariable;
            else
                variableMap[projection] = this._converter.getEntityVariable();
        }
        
        if (node.operator === '==' || node.operator === 'contains' || node.operator === 'in_array') {
            const statements = this._converter.convertExpression(node.rhs.optimize(), this._subjectProperties, false, variableMap);
            this._statements.push(...statements);
        } else if (node.operator === '>=' || node.operator === '<=' ) {
            const statements = this._converter.convertExpression(node.rhs.optimize(), this._subjectProperties, false, variableMap);
            this._statements.push(...statements);
            this._statements.push(`FILTER(?${filterVariable} ${node.operator[0]} ?${variableMap[projection]}).`);
        } else {
            throw new Error('Unsupported operator for subquery: ' + node.operator);
        }
        return false;
    }
}

interface Entity {
    value : string,
    name : string,
    canonical : string
}

interface Order {
    variable : string, 
    direction : 'asc' | 'desc'
}

interface Aggregation {
    operator : string;
    variable : string;
}

function aggregationToString(agg : Aggregation) {
    if (agg.operator === 'count')
        return `(COUNT(DISTINCT ?${agg.variable}) as ?count)`;
    else 
        return `(${agg.operator.toUpperCase()}(?${agg.variable}) as ?${agg.operator})`;
}

interface ThingTalkToSPARQLConverterOptions {
    locale : string,
    timezone ?: string,
    cache : string,
    save_cache : boolean,
    bootleg : string,
    human_readable_instance_of : boolean
}
export default class ThingTalkToSPARQLConverter {
    private _classDef : Ast.ClassDef;
    private _locale : string;
    private _timezone ?: string;
    private _kb : WikidataUtils;
    private _preprocessor : RuleBasedPreprocessor;
    private _patternConverter : PatternConverter;
    private _propertyMap : Record<string, string>;
    private _domainMap : Record<string, string>;
    private _variableMap : Record<string, string>;

    private _entityVariableCount : number;
    private _predicateVariableCount : number;

    private _resultVariable : string|null;
    private _isBooleanQuestion : boolean;
    private _statements : string[];
    private _having : string[];
    private _order : Order|null;
    private _limit : number|null;
    private _offset : number|null;
    private _aggregation : Aggregation|null;
    private _humanReadableInstanceOf : boolean;

    constructor(classDef : Ast.ClassDef, domains : Entity[], options : ThingTalkToSPARQLConverterOptions) {
        this._classDef = classDef;
        this._locale = options.locale;
        this._timezone = options.timezone;

        this._kb = new WikidataUtils(options.cache, options.bootleg, options.save_cache);
        this._preprocessor = new RuleBasedPreprocessor(this._kb);
        this._patternConverter = new PatternConverter();
        this._propertyMap = { "P31" : "instance_of" };
        for (const property of this._classDef.queries['entity'].iterateArguments()) {
            const qid = property.getImplementationAnnotation('wikidata_id') as string;
            this._propertyMap[property.name] = qid;
            const elemType = property.type instanceof Type.Array ? property.type.elem : property.type;
            if (elemType instanceof Type.Compound) {
                for (const field in elemType.fields) {
                    if (field === 'value')
                        continue;
                    const qid = elemType.fields[field].getImplementationAnnotation('wikidata_id') as string;
                    this._propertyMap[field] = qid;
                }
            }
        }
        this._domainMap = { 'art museum' : 'Q207694' };
        for (const domain of domains) {
            if (options.human_readable_instance_of) {
                const qid = domain.name.match(/Q[0-9]+/g)![0];
                this._domainMap[domain.value] = qid;
                this._domainMap[qid] = qid;
            } else {
                this._domainMap[domain.canonical] = domain.value;
            }
        }
        this._variableMap = {};

        this._humanReadableInstanceOf = options.human_readable_instance_of;

        this._entityVariableCount = 0;
        this._predicateVariableCount = 0;
        this._statements = [];
        this._having = [];
        this._resultVariable = null;
        this._isBooleanQuestion = false;
        this._order = null;
        this._limit = null;
        this._offset = null;
        this._aggregation = null;
    }

    get class() {
        return this._classDef;
    }

    get kb() {
        return this._kb;
    }

    get humanReadableInstanceOf() {
        return this._humanReadableInstanceOf;
    }

    getEntityVariable(property ?: string) : string {
        if (!property)
            return ENTITY_VARIABLES[this._entityVariableCount ++];
        if (property in this._variableMap) 
            return this._variableMap[property];
        this._variableMap[property] = ENTITY_VARIABLES[this._entityVariableCount ++];
        return this._variableMap[property];
    }

    getPredicateVariable() : string {
        return PREDICATE_VARIABLES[this._predicateVariableCount ++];
    }

    getWikidataProperty(property : string) : string {
        return this._propertyMap[property];
    }

    getWikidataDomain(domain : string) : string|null {
        if (this._kb.isEntity(domain))
            return domain;
        if (domain in this._domainMap)
            return this._domainMap[domain];
        throw new Error('Unknown domain: ' + domain);
    }

    addStatement(statement : string) {
        if (!this._statements.includes(statement))
            this._statements.push(statement);
    }

    addHaving(having : string) {
        this._having.push(having);
    }

    setIsBooleanQuestion() {
        this._isBooleanQuestion = true;
    }

    setResultVariable(variable : string) {
        this._resultVariable = variable;
    }

    setOrder(order : Order) {
        this._order = order;
    }

    setLimit(index : number) {
        this._limit = index;
    }

    setOffset(offset : number) {
        this._offset = offset;
    }

    setAggregation(operator : string, variable : string) {
        this._aggregation = { operator, variable };
    }

    private _reset() {
        this._entityVariableCount = 0;
        this._predicateVariableCount = 0;
        this._statements = [];
        this._having = [];
        this._order = null;
        this._limit = null;
        this._offset = null;
        this._resultVariable = null;
        this._isBooleanQuestion = false;
        this._aggregation = null;
        this._variableMap = {};
    }

    private _targetProjectionName(ast : Ast.Expression) {
        if (ast instanceof Ast.ProjectionExpression) {
            assert(ast.args.length > 0 || ast.computations.length === 1);
            if (ast.args.length > 0) 
                return ast.args.join('|');
            if (ast.computations.length === 1)
                return ast.computations[0].prettyprint();
        }
        if (ast instanceof Ast.ProjectionExpression2) {
            assert(ast.projections.length === 1);
            return ast.projections[0].prettyprint();
        }
        return null;
    }

    convertExpression(ast : Ast.Expression, subjectProperties : string[] = [], isMainExpression = true, variableMapping : Record<string, string> = {}) : string[] {
        // save out of scope variable mapping, load in scope variable mapping 
        const outVariableMapping = this._variableMap;
        this._variableMap = variableMapping;

        const tableInfoVisitor = new TableInfoVisitor(this);
        ast.visit(tableInfoVisitor);
        let subject;
        if (tableInfoVisitor.subject) {
            subject = tableInfoVisitor.subject;
        } else {
            if (this._variableMap['id'])
                subject = this._variableMap['id'];
            else 
                subject = this.getEntityVariable();
        }
        if (isMainExpression && isVariable(subject))
            this.setResultVariable(subject);
        const domain = tableInfoVisitor.mainDomain ? this.getWikidataDomain(tableInfoVisitor.mainDomain) : null;
        this._variableMap = variableMapping;
        const tripleGenerator = new TripleGenerator(this, subject, subjectProperties, isMainExpression ? this._targetProjectionName(ast) : null, domain);
        ast.visit(tripleGenerator);

        // restore out of scope variable
        this._variableMap = outVariableMapping;
        return tripleGenerator.statements;
    }

    async convert(utterance : string, thingtalk : string) : Promise<string> {
        this._reset();

        // preprocess
        thingtalk = await this._preprocessor.preprocess(thingtalk, 'thingtalk');

        // try pattern match first
        const patternConverterResult = this._patternConverter.toSPARQL(thingtalk);
        if (patternConverterResult)
            return patternConverterResult;

        const entities = EntityUtils.makeDummyEntities(utterance);
        const ast = Syntax.parse(thingtalk, Syntax.SyntaxType.Tokenized, entities, {
            locale : this._locale, timezone: this._timezone
        });
        assert(ast instanceof Ast.Program);
        const expr = (ast.statements[0] as Ast.ExpressionStatement).expression;
        assert(expr instanceof Ast.ChainExpression && expr.expressions.length === 1);
        const table = expr.expressions[0];

        // hack: collect properties for the subject
        // node visitors can not be async, so we need to prepare this information ahead of time
        // this won't work for subquery where subject is different
        // also collect domains that need to find QID 
        const tableInfoVisitor = new TableInfoVisitor(this);
        table.visit(tableInfoVisitor);
        const properties = [];
        if (tableInfoVisitor.subject) {
            const subject = tableInfoVisitor.subject.slice(ENTITY_PREFIX.length + 1, -1);
            const connectedProperties = await this._kb.getConnectedProperty(subject, false);
            const connectedQualifiers = await this._kb.getConnectedPropertyQualifiers(subject, connectedProperties);
            properties.push(...connectedProperties, ...connectedQualifiers);
        }
        for (const domainName of tableInfoVisitor.domainNames) {
            if (domainName in this._domainMap)
                continue;
            const domain = await this._kb.getEntityByName(domainName);
            if (domain === null)
                throw new Error('Unknown domain: ' + domainName);
            this._domainMap[domainName] = domain;
        }

        const statements = await this.convertExpression(table, properties);  
        statements.forEach((stmt) => this.addStatement(stmt));

        let sparql = '';
        // ask/select
        if (this._isBooleanQuestion) 
            sparql += 'ASK '; 
        else if (this._aggregation) 
            sparql += `SELECT ${aggregationToString(this._aggregation)} `;
        else  
            sparql += `SELECT DISTINCT ?${this._resultVariable} `;

        // where clauses
        sparql += `WHERE { ${this._statements.join((' '))} }`;

        // having clauses
        if (this._having.length > 0)
            sparql += ` GROUP BY ?${this._resultVariable} HAVING(${this._having.join(' && ')})`;
        
        // order claueses
        if (this._order)
            sparql += ` ORDER BY ${this._order.direction === 'desc'? `DESC(${this._order.variable})` : this._order.variable}`;
        if (this._limit)
            sparql += ` LIMIT ${this._limit}`;
        if (this._offset)
            sparql += ` OFFSET ${this._offset}`;
        return sparql;
    }
}