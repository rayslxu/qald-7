import * as fs from 'fs';
import { promises as pfs } from 'fs';
import assert from 'assert';
import * as stream from 'stream';
import JSONStream from 'JSONStream';
import { Ast, Type } from 'thingtalk';
import * as ThingTalk from 'thingtalk';
import { 
    SelectQuery, 
    Parser, 
    SparqlParser, 
    AskQuery, 
    Triple,
    OperationExpression
} from 'sparqljs';
import * as argparse from 'argparse';
import { 
    waitFinish, 
    closest, 
    getSpans,
} from './utils/misc';
import {
    baseQuery,
    makeProgram,
    makeSubqueryProgram,
    makeSubqueryVerificationProgram,
    elemType
} from './utils/thingtalk';
import { 
    postprocessPropertyPath,
    parseSpecialUnion
} from './utils/sparqljs';
import {
    isNamedNode,
    isWikidataEntityNode,
    isVariable,
    isLiteral,
    isWikidataPropertyNode,
    isUnaryPropertyPath,
    isPropertyPath,
    isFilterPattern,
    isBasicGraphPattern,
    isUnionPattern,
    isAggregateExpression
} from './utils/sparqljs-typeguard';
import { ENTITY_PREFIX, PROPERTY_PREFIX, LABEL } from './utils/wikidata';
import { ENTITY_SPAN_OVERRIDE, MANUAL_CONVERSION } from './utils/qald';
import WikidataUtils from './utils/wikidata';
import { WikiSchema } from './schema';
import { I18n, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';


interface Projection {
    property : string|Ast.PropertyPathSequence, 
    variable ?: string,
    type ?: string
}

// comparison is used for making comparison between two tables
// lhs and rhs should be the variable name used for the comparison in SPARQL
interface Comparison {
    lhs : string,
    operator : string, 
    rhs : string
}

interface Table {
    domain : string,
    projections : Projection[],
    filters : Ast.BooleanExpression[],
    verifications : Ast.BooleanExpression[]
}

interface SPARQLToThingTalkConverterOptions {
    cache : string;
}

export default class SPARQLToThingTalkConverter {
    private _schema : WikiSchema;
    private _parser : SparqlParser;
    private _wikidata : WikidataUtils;
    private _tokenizer : I18n.BaseTokenizer;
    private _keywords : string[];
    private _tables : Record<string, Table>;
    private _comparison : Comparison[];

    constructor(classDef : Ast.ClassDef, options : SPARQLToThingTalkConverterOptions) {
        this._schema = new WikiSchema(classDef);
        this._parser = new Parser();
        this._wikidata = new WikidataUtils(options.cache);
        this._tokenizer = new I18n.LanguagePack('en').getTokenizer();
        this._tables = {};
        this._comparison = [];
        this._keywords = [];
    } 

    /**
     * Initialize a table (in ThingTalk) for a subject (in SPARQL)
     * @param subject the subject of the table, either a variable, or a Wikidata entity
     */
    private _initTable(subject : string) {
        if (!(subject in this._tables))
            this._tables[subject] = { domain: 'entity', projections: [], filters: [], verifications: [] };
    }

    /**
     * Add a filter to a able
     * @param subject the subject, a variable in SPARQL
     * @param filter a filter to add to the subject
     */
    private _addFilter(subject : string, filter : Ast.BooleanExpression) {
        this._initTable(subject);
        this._tables[subject].filters.push(filter);
    }

    /**
     * Add a projection to a table
     * @param subject the subject, either a variable, or an entity
     * @param projection a projection to add to the subject
     */
    private _addProjection(subject : string, projection : Projection) {
        this._initTable(subject);
        this._tables[subject].projections.push(projection);
    }

    /**
     * Add a verification (boolean question) to a table
     * @param subject the subject, either a variable, or an entity
     * @param verification a verification to add to the subject
     */
    private _addVerification(subject : string, verification : Ast.BooleanExpression) {
        this._initTable(subject);
        this._tables[subject].verifications.push(verification);
    }

    /**
     * Set the domain for a table
     * @param subject the subject, either a variable or an entity
     * @param domain the QID of the domain
     */
    private _setDomain(subject : string, domain : string) {
        this._initTable(subject);
        this._tables[subject].domain = this._schema.getTable(domain);
    }
     
    /**
     * Convert a value in SPARQL into a ThingTalk value
     * @param value a value in the SPARQL triple
     * @param type the ThingTalk type of the value
     * @returns a ThingTalk value
     */
    private async _toThingTalkValue(value : any, type : Type) : Promise<Ast.Value> {
        if (type instanceof Type.Entity) {
            assert(typeof value === 'string' && value.startsWith(ENTITY_PREFIX));
            value = value.slice(ENTITY_PREFIX.length);
            const wikidataLabel = await this._wikidata.getLabel(value);
            assert(wikidataLabel);
            let display = closest(wikidataLabel, this._keywords);
            if (!display) {
                if (ENTITY_SPAN_OVERRIDE[value]) 
                    display = ENTITY_SPAN_OVERRIDE[value];
                else
                    throw new Error(`Failed find matching span for entity ${value} : ${wikidataLabel} among ${this._keywords}`);
            }
            return new Ast.Value.Entity(value, type.type, display); 
        } 
        if (type instanceof Type.Enum) {
            assert(typeof value === 'string' && value.startsWith(ENTITY_PREFIX));
            value = value.slice(ENTITY_PREFIX.length);
            const wikidataLabel = await this._wikidata.getLabel(value);
            assert(wikidataLabel);
            return new Ast.Value.Enum(wikidataLabel); 
        }
        if (type === Type.Number)
            return new Ast.Value.Number(parseFloat(value));
        if (type === Type.String) 
            return new Ast.Value.String(value);
        if (type instanceof Type.Compound)
            return this._toThingTalkValue(value, type.fields.value.type);

        throw new Error('Unsupported value type: ' + type);
    }

    /**
     * Creat an atom filter 
     * @param property the predicate derived from SPARQL (either a name or a Wikidata property)
     * @param value the value derived from SPARQL
     * @param operator operator, by default will be == or contains depending on the property type
     * @param valueType the type of the value
     * @returns a ThingTalk filter: "$property = $value"
     */
    private async _atomFilter(property : string, value : any, operator ?: string, valueType ?: Type) : Promise<Ast.AtomBooleanExpression> {
        let propertyLabel, propertyType;
        if (property === 'id') {
            propertyLabel = property;
            propertyType = valueType!;
        } else {
            if (property.startsWith(PROPERTY_PREFIX)) {
                property = property.slice(PROPERTY_PREFIX.length);
                propertyLabel = this._schema.getProperty(property);
            } else {
                propertyLabel = property;
            }
            propertyType = this._schema.getPropertyType(propertyLabel);
        }
        if (operator === '>' || operator === '<') 
            operator = operator + '=';
        if (valueType === Type.String) 
            operator = propertyType instanceof Type.Array ? 'contains~' : '=~';
        return new Ast.AtomBooleanExpression(
            null,
            propertyLabel,
            operator ?? (propertyType instanceof Type.Array ? 'contains' : '=='),
            await this._toThingTalkValue(value, valueType ?? elemType(propertyType)),
            null
        );
    }

    private _aggregateFilter(aggregation : string, operands : string[], operator : string, value : number) {
        if (operator === '>' || operator === '<') 
            operator = operator + '=';
        return new Ast.ComputeBooleanExpression(
            null,
            new Ast.ComputationValue(aggregation, operands.map((op) => new Ast.Value.VarRef(op))),
            operator, 
            new Ast.Value.Number(value)
        );
    }

    private async _convertSequencePathTriple(triple : any, filtersBySubject : Record<string, Ast.BooleanExpression[]>) {
        const subject = triple.subject.value;
        const predicate = triple.predicate;
        const object = triple.object.value;
        // if subject is an entity, create an id filter
        if (isWikidataEntityNode(triple.subject)) {
            const domain = await this._wikidata.getDomain(subject.slice(ENTITY_PREFIX.length));
            assert(domain);
            const table = this._schema.getTable(domain);
            assert(table);
            this._addFilter(subject, await this._atomFilter('id', subject, '==', new Type.Entity(`org.wikidata:${table}`)));
            this._setDomain(subject, domain);
        }
        const sequence : Ast.PropertyPathSequence = [];
        if (isUnaryPropertyPath(predicate)) {
            assert(predicate.items.length === 1 && isNamedNode(predicate.items[0]));
            const property = this._schema.getProperty(predicate.items[0].value.slice(PROPERTY_PREFIX.length));
            sequence.push(new Ast.PropertyPathElement(property, predicate.pathType as '*'|'+'));
        } else {
            // sequence property path
            for (const element of predicate.items) {
                if (isWikidataPropertyNode(element)) {
                    const property = this._schema.getProperty(element.value.slice(PROPERTY_PREFIX.length));
                    sequence.push(new Ast.PropertyPathElement(property));
                } else if (isUnaryPropertyPath(element)) {
                    assert(element.items.length === 1 && isNamedNode(element.items[0]));
                    const property = this._schema.getProperty(element.items[0].value.slice(PROPERTY_PREFIX.length));
                    sequence.push(new Ast.PropertyPathElement(property, element.pathType as '*'|'+'));
                }
            }
        }
        const lastPropertyType = this._schema.getPropertyType(sequence[sequence.length - 1].property);
        if (triple.object.termType === 'Variable') {
            this._addProjection(subject, { property : sequence, variable : object });
        } else {
            const value = await this._toThingTalkValue(object, elemType(lastPropertyType));
            const filter = new Ast.PropertyPathBooleanExpression(
                null, 
                sequence, 
                lastPropertyType instanceof Type.Array ? 'contains' : '==',
                value, 
                null
            );
            if (isNamedNode(triple.subject) && isNamedNode(triple.object)) 
                this._addVerification(subject, filter);
            else 
                this._addFilter(subject, filter);
        }
        
    }

    private async _convertBasicTriple(triple : any, filtersBySubject : Record<string, Ast.BooleanExpression[]>) {
        const subject = triple.subject.value;
        let predicate = triple.predicate.value;
        const object = triple.object.value;

        if (!subject || !predicate || !object)
            throw new Error(`Unsupported triple: ${JSON.stringify(triple)}`);

        // if subject is an entity, create an id filter first
        if (isWikidataEntityNode(triple.subject)) {
            const domain = await this._wikidata.getDomain(subject.slice(ENTITY_PREFIX.length));
            assert(domain);
            const table = this._schema.getTable(domain);
            assert(table);
            this._addFilter(subject, await this._atomFilter('id', subject, '==', new Type.Entity(`org.wikidata:${table}`)));
            this._setDomain(subject, domain);
        }

        // if subject is an variable and object is an entity, create a regular filter
        if (triple.subject.termType === 'Variable' && triple.object.termType !== 'Variable') { 
            // for P31 triple, update the domain of the variable, do not add filter
            if (isWikidataPropertyNode(triple.predicate, 'P31')) {
                this._setDomain(subject, object.slice(ENTITY_PREFIX.length));
                return;
            }
            if (!(subject in filtersBySubject))
                filtersBySubject[subject] = [];
            const valueType = isLiteral(triple.object) ? Type.String : undefined;
            if (valueType) {
                if (subject in this._tables) {
                    predicate = 'id';
                } else {
                    let match;
                    for (const t of Object.values(this._tables)) {
                        match = t.projections.find((proj) => proj.variable === subject);
                        if (match) 
                            break;
                    } 
                    if (!match)
                        throw new Error(`Cannot find projection ${subject}`);
                    if (!(typeof match.property === 'string'))
                        throw new Error(`Property path not supported for label filter`);
                    predicate = match.property;
                }
            }
            filtersBySubject[subject].push(await this._atomFilter(predicate, object, undefined, valueType));
        } 

        // if object is an variable, create a projection
        if (triple.object.termType === 'Variable') {
            // if predicate is label, add a new projection with suffix "Label" for the property
            if (predicate === LABEL) {
                for (const [subj, table] of Object.entries(this._tables)) {
                    const projection = table.projections.find((proj) => proj.variable === subject);
                    if (projection) {
                        this._addProjection(subj, { variable : object, property : projection.property + 'Label' });
                        break;
                    }
                }
            } else {
                const property = this._schema.getProperty(predicate.slice(PROPERTY_PREFIX.length));
                this._addProjection(subject, { variable: object, property });
            }
        }

        // if both subject and object are entities, create a "verification", for boolean question
        if (isNamedNode(triple.subject) && isNamedNode(triple.object)) 
            this._addVerification(subject, await this._atomFilter(predicate, object));
    }

    /**
     * Convert RDF triples into thingtalk filters by subjects
     * @param triples RDF Triples derived from SPARQL
     * @returns a map from subjects to their ThingTalk filters converted from the triples
     */
    private async _convertTriples(triples : Triple[]) : Promise<Record<string, Ast.BooleanExpression>> {
        const filtersBySubject : Record<string, Ast.BooleanExpression[]> = {};
        for (const triple of triples) {
            triple.predicate = postprocessPropertyPath(triple.predicate);
            if (isPropertyPath(triple.predicate))
                await this._convertSequencePathTriple(triple, filtersBySubject);
            else 
                await this._convertBasicTriple(triple, filtersBySubject);
            
        }
        const converted : Record<string, Ast.BooleanExpression> = {};
        for (const [subject, filters] of Object.entries(filtersBySubject)) 
            converted[subject] = filters.length === 1 ? filters[0] : new Ast.AndBooleanExpression(null, filters);
        return converted;
    }

    /**
     * Parse a union where clause
     * @param where a where clause
     */
    private async _parseUnion(where : any)  {
        const triple = parseSpecialUnion(where);
        if (triple) {
            await this._parseBasic( { triples: [triple] });
            return;
        }
        let existedSubject;
        const operands = [];
        for (const pattern of where.patterns) {
            assert(isBasicGraphPattern(pattern));
            const filtersBySubject = await this._convertTriples(pattern.triples);
            for (const [subject, filter] of Object.entries(filtersBySubject)) {
                if (!existedSubject)
                    existedSubject = subject;
                else if (subject !== existedSubject)
                    throw new Error(`Multiple subject in filter ${where.patterns}`);
                operands.push(filter);
            }
        }
        this._addFilter(existedSubject as string, new Ast.OrBooleanExpression(null, operands));
    }

    /**
     * Parse a filter expression where the operation is a binary operation
     * @param expression a filter expression
     * @param isVerification if it's a verification question or not
     * @param negate if the filter should be negated 
     */
    private async _parseBinaryOperation(expression : OperationExpression, isVerification : boolean, negate : boolean) {
        const [lhs, rhs] = expression.args;
        assert(isVariable(lhs));

        let operator = expression.operator;
        if (operator === '>' || operator === '<')
            operator += '=';
        if (isVariable(rhs)) {
            this._comparison.push({
                lhs: lhs.value,
                operator: operator,
                rhs: rhs.value
            });
        } else if (isLiteral(rhs)) {
            for (const [subject, table] of Object.entries(this._tables)) {
                const projection = table.projections.find((proj) => proj.variable === lhs.value);
                if (!projection)
                    continue;

                if (typeof projection.property !== 'string')
                    throw new Error(`Join on property path not supported`);
                
                let booleanExpression;
                if (projection.property.endsWith('Label')) {
                    assert(operator === 'regex');
                    const property = projection.property.slice(0, -'Label'.length);
                    const propertyType = this._schema.getPropertyType(property);
                    operator = (propertyType instanceof Type.Array) ? 'contains~' : '=~';
                    booleanExpression = await this._atomFilter(property, rhs.value, operator, Type.String);
                } else {
                    booleanExpression = await this._atomFilter(projection.property, rhs.value, operator, Type.Number);
                }

                if (negate)
                    booleanExpression = new Ast.NotBooleanExpression(null, booleanExpression);
                
                if (isVerification)
                    this._addVerification(subject, booleanExpression);
                else 
                    this._addFilter(subject, booleanExpression);
            }
        } else {
            throw new Error(`Unsupported binary operation ${expression.operator} with value ${rhs}`);
        }
    }

    /**
     * Parse a filter expression where the operation is a unary operation
     * @param expression a filter expression
     * @param isVerification if it's a verification question or not
     * @param negate if the filter should be negated 
     */
    private async _parseUnaryOperation(expression : OperationExpression, isVerification : boolean, negate : boolean) {
        const arg = expression.args[0];
        let subject, booleanExpression;
        if (expression.operator === 'bound') {
            assert(isVariable(arg));
            let match;
            for (const [s, t] of Object.entries(this._tables)) {
                match = t.projections.find((proj) => proj.variable === arg.value);
                if (match) {
                    subject = s;
                    break;
                }
            } 
            if (!match)
                throw new Error(`Cannot find projection ${arg.value}`);
            if (typeof match.property === 'string') {
                const propertyType = this._schema.getPropertyType(match.property);
                if (propertyType instanceof Type.Array) {
                    booleanExpression = new Ast.ComputeBooleanExpression(
                        null,
                        new Ast.Value.Computation('count', [new Ast.Value.VarRef(match.property)]),
                        '==',
                        new Ast.Value.Number(0)
                    );
                } else {
                    booleanExpression = new Ast.AtomBooleanExpression(null, match.property, '==', new Ast.Value.Null, null);
                }
            } else {
                booleanExpression = new Ast.PropertyPathBooleanExpression(null, match.property, '==', new Ast.Value.Null, null);
            }
            
        }
        if (!booleanExpression || !subject)
            throw new Error(`Unsupported operator ${expression.operator}`);
        if (negate)
            booleanExpression = new Ast.NotBooleanExpression(null, booleanExpression);
        
        if (isVerification)
            this._addVerification(subject, booleanExpression);
        else 
            this._addFilter(subject, booleanExpression);
    }

    /**
     * Parse a filter expression (with SPARQL keyword "FILTER")
     * @param expression a filter expression
     * @param isVerification if it's a verification question or not
     * @param negate if the filter should be negated 
     */
    private async _parseFilter(expression : OperationExpression, isVerification : boolean, negate = false) {
        assert(expression.type === 'operation');
        if (expression.operator === '!')
            await this._parseFilter(expression.args[0] as OperationExpression, isVerification, !negate);
        else if (expression.args.length === 1)
            await this._parseUnaryOperation(expression, isVerification, negate);
        else if (expression.args.length === 2)
            await this._parseBinaryOperation(expression, isVerification, negate);
    }

    /**
     * Parse a basic triple where clause
     * @param where a where clause
     */
    private async _parseBasic(where : any, isVerification = false) {
        const filtersBySubject = await this._convertTriples(where.triples);
        for (const [subject, filter] of Object.entries(filtersBySubject)) { 
            if (isVerification)
                this._addVerification(subject, filter);
            else
                this._addFilter(subject, filter);  
        }
    }

    /**
     * Parse a where clause
     * @param where a where clause
     * @param isVerification if it's a verification question or not
     */
    private async _parseWhereClause(where : any, isVerification : boolean) {
        if (isBasicGraphPattern(where)) 
            await this._parseBasic(where, isVerification);
        else if (isUnionPattern(where)) 
            await this._parseUnion(where);
        else if (isFilterPattern(where))
            await this._parseFilter(where.expression as OperationExpression, isVerification);
        else 
            throw new Error(`Unsupported filter ${JSON.stringify(where)}`);
    }

    private async _parseHavingClause(having : any, group : any) {
        assert(group.expression && group.expression.termType === 'Variable');
        const subject = group.expression.value;
        if (!(subject in this._tables)) 
            throw new Error('Unsupported group by operation on object');
        if (having.type === 'operation') {
            assert(having.args.length === 2);
            const [lhs, rhs] = having.args;
            assert(isAggregateExpression(lhs, 'count') && isVariable(lhs.expression) && !lhs.distinct);
            const variable = lhs.expression.value;
            const projection = this._tables[subject].projections.find((proj) => proj.variable === variable);
            if (!projection)
                throw new Error(`Can't find matching variable for the having clause`);
            if (typeof projection.property !== 'string')
                throw new Error(`Having clause not supported for property path`);
            assert(isLiteral(rhs) && Number(rhs.value));
            this._addFilter(subject, this._aggregateFilter('count', [projection.property], having.operator, parseFloat(rhs.value)));
        } else {
            throw new Error(`Unsupported having clause ${JSON.stringify(having)}`);
        }
    }
    
    /**
     * init tables used to track the conversion
     */
    private _init(utterance : string, keywords : string[]) {
        this._tables = {};
        this._comparison = [];
        if (keywords.length === 0)
            this._keywords = getSpans(utterance);
        else 
            this._keywords = keywords.map((keyword) => this._tokenizer.tokenize(keyword).rawTokens.join(' '));
    }

    /**
     * Convert SPARQL into ThingTalk
     * @param sparql a string of SPARQL query 
     * @param utterance a string of the utterance
     * @param keywords a list of keywords in the utterance including the mentioned entities 
     * @returns A ThingTalk Program
     */
    async convert(sparql : string, utterance : string, keywords : string[] = []) : Promise<Ast.Program> { 
        this._init(utterance, keywords);
        const parsed = this._parser.parse(sparql) as SelectQuery|AskQuery;
        if (parsed.where) {
            for (const clause of parsed.where.filter((clause) => clause.type !== 'filter')) 
                await this._parseWhereClause(clause, parsed.queryType === 'ASK');
            for (const clause of parsed.where.filter((clause) => clause.type === 'filter')) 
                await this._parseWhereClause(clause, parsed.queryType === 'ASK');
        }
        if ('having' in parsed && 'group' in parsed) {
            assert(parsed.group!.length === 1);
            for (const clause of parsed.having ?? []) 
                await this._parseHavingClause(clause, parsed.group![0]);
        }
        const queries : Record<string, Ast.Expression> = {}; // subject : query
        const aggregation : Record<string, string> = {}; // aggregation type : aggregation subject
        const variables : string[] = [];
        if ('variables' in parsed) {
            for (const variable of parsed.variables ?? []) {
                if ('value' in variable && variable.value !== '*') {
                    variables.push(variable.value);
                } else if ('expression' in variable && isAggregateExpression(variable.expression, 'count')) {
                    const expression = variable.expression.expression;
                    assert(isVariable(expression));
                    aggregation.count = expression.value;
                } else {
                    throw new Error(`Unsupported variable type: ${variable}`);
                }
            }
        }

        // first check tables with only domain information, it can potentially be resolved with a type annotation
        // on another table's projection
        // only apply to selection not verification
        if (parsed.queryType === 'SELECT') {
            for (const [subject, table] of Object.entries(this._tables)) {
                if (subject.startsWith(ENTITY_PREFIX))
                    continue;
                let isProjected = false;
                if (table.domain !== 'entity' && 
                    table.filters.length === 0 && 
                    table.projections.length === 0 &&
                    table.verifications.length === 0) {
                    for (const table2 of Object.values(this._tables)) {
                        const proj = table2.projections.find((p) => p.variable === subject);
                        if (proj) {
                            isProjected = true;
                            proj.type = table.domain;
                        }
                    }
                }
                if (isProjected)
                    delete this._tables[subject];
            }
        }

        // parse all tables into thingtalk
        for (const [subject, table] of Object.entries(this._tables)) {
            // handle filters
            let query : Ast.Expression = baseQuery(table.domain);
            if (table.filters.length > 0)
                query = new Ast.FilterExpression(null, query, new Ast.BooleanExpression.And(null, table.filters), null);

            // handle aggregation count
            // if there is a count aggregation, projection/verification/sorting makes no sense
            // finish this table and continue
            if (aggregation.count && aggregation.count === subject) {
                query = new Ast.AggregationExpression(null, query, '*', 'count', null);
                queries[subject] = query;  
                continue;
            }

            // handle projections and verifications
            const projections : Projection[] = [];
            // handle variables that is used in comparison
            const comparisonProjection : Projection[] = [];
            if (variables.includes(subject))
                projections.push({ property : 'id' });
            for (const projection of table.projections) {
                if (variables.includes(projection.variable!) || Object.keys(this._tables).includes(projection.variable!))
                    projections.push(projection);
                if (this._comparison.length > 0) {
                    for (const comparison of this._comparison) {
                        if (comparison.lhs === projection.variable || comparison.rhs === projection.variable)
                            comparisonProjection.push(projection);
                    }
                } 
            }
            if (parsed.queryType === 'ASK') {
                if (table.verifications.length > 0) {
                    assert(projections.length === 0);
                    const verification = table.verifications.length > 1 ? new Ast.AndBooleanExpression(null, table.verifications) : table.verifications[0];
                    query = new Ast.BooleanQuestionExpression(null, query, verification, null);
                } else {
                    const projections = table.projections.filter((proj) => 
                        this._comparison.every((comparison) => ![comparison.lhs, comparison.rhs].includes(proj.variable!))
                    );
                    if (projections.length > 0) {
                        const isNullVerifications = projections.map((proj) => {
                            if (typeof proj.property === 'string') {
                                // if there is other tables for the projection, do not create a is null verification, a subquery is needed
                                if (proj.variable && proj.variable in this._tables)
                                    return null;
                                const propertyType = this._schema.getPropertyType(proj.property);
                                if (propertyType instanceof Type.Array) {
                                    return new Ast.ComputeBooleanExpression(
                                        null,
                                        new Ast.Value.Computation('count', [new Ast.Value.VarRef(proj.property)]),
                                        '==',
                                        new Ast.Value.Number(0)
                                    );
                                }
                                return new Ast.AtomBooleanExpression(null, proj.property, '==', new Ast.Value.Null, null);
                            }
                            return new Ast.PropertyPathBooleanExpression(null, proj.property, '==', new Ast.Value.Null, null);
                        }).filter((Boolean)) as Ast.BooleanExpression[];
                        if (isNullVerifications.length > 0) {
                            const verification = new Ast.NotBooleanExpression(
                                null, 
                                isNullVerifications.length > 1 ? new Ast.OrBooleanExpression(null, isNullVerifications) : isNullVerifications[0]
                            );
                            query = new Ast.BooleanQuestionExpression(null, query, verification, null);
                        }
                    }
                }
            } else if (parsed.queryType === 'SELECT') {
                // if it's not a verification question, and there is no projection/verification 
                // for a table, skip the table - it's a helper table to generate filter
                if (projections.length === 0 && comparisonProjection.length === 0)
                    continue;
                if (!(projections.length === 1 && projections[0].property === 'id') && projections.length !== 0) {
                    const projectionElements = projections.map((proj) => {
                        return new Ast.ProjectionElement(
                            proj.property,
                            null,
                            proj.type ? [new Type.Entity(`org.wikidata:${proj.type}`)] : []
                        );
                    });
                    query = new Ast.ProjectionExpression2(null, query, projectionElements, null);
                } 
            }

            // handle sorting
            if ('order' in parsed) {
                assert(parsed.order!.length === 1);
                const expression = parsed.order![0].expression;
                assert('termType' in expression && expression.termType === 'Variable');
                const projection = table.projections.find((proj) => proj.variable === expression.value);
                if (projection) {
                    if (typeof projection.property !== 'string')
                        throw new Error(`Sort on property path not supported`);
                    const property = new Ast.Value.VarRef(projection.property);
                    const direction = parsed.order![0].descending ? 'desc' : 'asc';
                    query = new Ast.SortExpression(null, query, property, direction, null);
                    if (parsed.limit)
                        query = new Ast.IndexExpression(null, query, [new Ast.Value.Number(parsed.limit)], null);
                }
            }

            queries[subject] = query;  
        } 
        
        if (Object.values(queries).length === 1) {
            const query = Object.values(queries)[0];
            if (parsed.queryType === 'ASK' && !(query instanceof Ast.BooleanQuestionExpression)) 
                throw new Error(`Unsupported verification question: ${sparql}`);
            return makeProgram(query); 
        }
        if (Object.values(queries).length === 2 && parsed.queryType === 'SELECT') {
            let [[mainSubject, main], [subquerySubject, subquery]] = Object.entries(queries);
            // the query without any projection in SPARQL variables should be the subquery
            // swap if necessary
            if (!this._tables[mainSubject].projections.some((proj) => variables.includes(proj.variable!)) && !variables.includes(mainSubject))
                [mainSubject, main, subquerySubject, subquery] = [subquerySubject, subquery, mainSubject, main];
            // verify 
            if (!this._tables[mainSubject].projections.some((proj) => variables.includes(proj.variable!)) && !variables.includes(mainSubject))
                throw new Error(`Failed to identify main query in ${sparql}`);
            if (this._tables[subquerySubject].projections.some((proj) => variables.includes(proj.variable!)))
                throw new Error(`Failed to identify subquery in ${sparql}.`);
                
            let subqueryFilter : Ast.ComparisonSubqueryBooleanExpression;
            if (this._comparison.length === 1) {
                // handle comparison of two entities with subquery  
                const comp = this._comparison[0];
                const mainProperty = this._tables[mainSubject].projections.find((proj) => 
                    proj.variable && (proj.variable === comp.lhs || proj.variable === comp.rhs)
                )!.property as string;
                const subqueryProperty = this._tables[subquerySubject].projections.find((proj) => 
                    proj.variable && (proj.variable === comp.lhs || proj.variable === comp.rhs)
                )!.property as string;
                subqueryFilter = new Ast.ComparisonSubqueryBooleanExpression(
                    null,
                    new Ast.Value.VarRef(mainProperty),
                    comp.operator,
                    new Ast.ProjectionExpression(null, subquery, [subqueryProperty], [], [], null),
                    null
                );

            } else if (this._tables[mainSubject].projections.some((proj) => proj.variable === subquerySubject)) {
                const projection = this._tables[mainSubject].projections.find((proj) => proj.variable === subquerySubject);
                const property = projection!.property;
                if (typeof property !== 'string')
                    throw new Error(`Subquery on property path not supported`);
                subqueryFilter = new Ast.ComparisonSubqueryBooleanExpression(
                    null,
                    new Ast.Value.VarRef(property),
                    this._schema.getPropertyType(property) instanceof Type.Array ? 'contains' : '==',
                    new Ast.ProjectionExpression(null, subquery, ['id'], [], [], null),
                    null
                );
            } else if (this._tables[subquerySubject].projections.some((proj) => proj.variable === mainSubject)) {
                const projection = this._tables[subquerySubject].projections.find((proj) => proj.variable === mainSubject);
                const property = projection!.property;
                if (typeof property !== 'string')
                    throw new Error(`Subquery on property path not supported`);
                subqueryFilter = new Ast.ComparisonSubqueryBooleanExpression(
                    null,
                    new Ast.Value.VarRef('id'),
                    this._schema.getPropertyType(property) instanceof Type.Array ? 'in_array' : '==',
                    subquery,
                    null
                );
            } else {
                throw new Error(`Failed to identify main & subquery in ${sparql}`);
            }
            
            return makeSubqueryProgram(main, subqueryFilter);
        }
        if (Object.values(queries).length >= 2 && parsed.queryType === 'ASK') {
            const mainSubject = Object.keys(queries).find((subject) => subject.startsWith(ENTITY_PREFIX));
            if (!mainSubject)
                throw new Error('No main function found');
            const main = queries[mainSubject];
            const subqueries = [];
            for (const [subject, query] of Object.entries(queries)) {
                if (subject === mainSubject)
                    continue;
                if (this._comparison.length === 1) {
                    // handle comparison of two entities with subquery  
                    const comp = this._comparison[0];
                    const mainProperty = this._tables[mainSubject].projections.find((proj) => 
                        proj.variable && (proj.variable === comp.lhs || proj.variable === comp.rhs)
                    )!.property as string;
                    const subqueryProperty = this._tables[subject].projections.find((proj) => 
                        proj.variable && (proj.variable === comp.lhs || proj.variable === comp.rhs)
                    )!.property as string;
                    subqueries.push(new Ast.ComparisonSubqueryBooleanExpression(
                        null,
                        new Ast.Value.VarRef(mainProperty),
                        comp.operator,
                        new Ast.ProjectionExpression(null, query, [subqueryProperty], [], [], null),
                        null
                    ));
                } else {
                    const proj = this._tables[mainSubject].projections.find((proj) => proj.variable === subject);
                    if (!proj)
                        throw new Error(`Not supported verification question: ${sparql}`);
                    if (typeof proj.property !== 'string')
                        throw new Error(`Subquery on property path not supported`);
                    subqueries.push(new Ast.ComparisonSubqueryBooleanExpression(
                        null,
                        new Ast.Value.VarRef(proj.property),
                        this._schema.getPropertyType(proj.property) instanceof Type.Array ? 'contains' : '==',
                        new Ast.ProjectionExpression(null, query, ['id'], [], [], null), 
                        null
                    ));
                }
            }
            return makeSubqueryVerificationProgram(main, subqueries);
        }

        throw new Error(`Not supported by ThingTalk: ${sparql}`);
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "A tool to convert QALD-7 SPARQL to ThingTalk"
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: undefined,
        help: `Timezone to use to interpret dates and times (defaults to the current timezone).`
    });
    parser.add_argument('--manifest', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    parser.add_argument('-d', '--drop', {
        required: false,
        type: fs.createWriteStream
    });
    parser.add_argument('--offset', {
        required: false,
        type: parseInt,
        default: 1,
        help: `Start from the nth example`
    });
    parser.add_argument('--include-entity-value', {
        action: 'store_true',
        default: false
    });
    const args = parser.parse_args();

    const manifest = await pfs.readFile(args.manifest, { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: args.locale, timezone: args.timezone });
    assert(library instanceof Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new SPARQLToThingTalkConverter(classDef, { cache: args.cache });
    const tokenizer = new I18n.LanguagePack('en').getTokenizer();

    const input = args.input.pipe(JSONStream.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
    const output = new DatasetStringifier();
    output.pipe(args.output);
    
    let counter = 0;
    for await (const item of input) {
        counter ++;
        if (counter < args.offset)
            continue;
        const preprocessed = tokenizer.tokenize(item.question[0].string).rawTokens.join(' ');
        try {
            if (item.query.sparql in MANUAL_CONVERSION) {
                output.write({ id: item.id, preprocessed, target_code: MANUAL_CONVERSION[item.query.sparql] });
            } else { 
                const program = await converter.convert(item.query.sparql, preprocessed);
                const target_code = ThingTalkUtils.serializePrediction(
                    program, 
                    preprocessed,
                    EntityUtils.makeDummyEntities(preprocessed),
                    { locale: 'en', timezone: undefined, includeEntityValue: args.include_entity_value }
                ).join(' ');
                output.write({ id: item.id, preprocessed, target_code });
            }
        } catch(e) {
            console.log(`Example ${item.id} failed`);
            if (args.drop)
                args.drop.write(`${item.id}\t${preprocessed}\t${item.query.sparql}\t${(e as Error).message.replace(/\s+/g, ' ')}\n`);
            else 
                console.log((e as Error).message);
        }
    }
    await waitFinish(input);
    await waitFinish(output);
    if (args.drop)
        await waitFinish(args.drop);
}

if (require.main === module)
    main();