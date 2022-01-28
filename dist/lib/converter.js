"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const fs_1 = require("fs");
const assert_1 = __importDefault(require("assert"));
const stream = __importStar(require("stream"));
const JSONStream_1 = __importDefault(require("JSONStream"));
const thingtalk_1 = require("thingtalk");
const ThingTalk = __importStar(require("thingtalk"));
const sparqljs_1 = require("sparqljs");
const argparse = __importStar(require("argparse"));
const misc_1 = require("./utils/misc");
const wikidata_1 = __importDefault(require("./utils/wikidata"));
const wikidata_2 = require("./utils/wikidata");
const genie_toolkit_1 = require("genie-toolkit");
const qald_1 = require("./utils/qald");
/**
 * A shortcut for quickly creating a basic query
 * @param domain the name of a domain
 * @return an invocation of a base domain query (no projection, no filter)
 */
function baseQuery(domain) {
    return new thingtalk_1.Ast.InvocationExpression(null, new thingtalk_1.Ast.Invocation(null, new thingtalk_1.Ast.DeviceSelector(null, 'org.wikidata', null, null), domain, [], null), null);
}
/**
 * A shortcut for creating a program from an query expression
 * @param expression a ThingTalk query expression
 * @returns a ThingTalk program
 */
function makeProgram(expression) {
    if (!(expression instanceof thingtalk_1.Ast.ChainExpression))
        expression = new thingtalk_1.Ast.ChainExpression(null, [expression], expression.schema);
    return new thingtalk_1.Ast.Program(null, [], [], [new thingtalk_1.Ast.ExpressionStatement(null, expression)]);
}
/**
 * A shortcut for creating a program with a subquery
 * @param main the main query
 * @param subquery the subquery
 * @returns a ThingTalk program
 */
function makeSubqueryProgram(main, subquery) {
    let filterTable = main;
    let parent;
    while (!(filterTable instanceof thingtalk_1.Ast.FilterExpression || filterTable instanceof thingtalk_1.Ast.InvocationExpression)) {
        parent = filterTable;
        filterTable = parent.expression;
    }
    if (filterTable instanceof thingtalk_1.Ast.FilterExpression)
        filterTable.filter = new thingtalk_1.Ast.AndBooleanExpression(null, [filterTable.filter, subquery]);
    else if (parent)
        parent.expression = new thingtalk_1.Ast.FilterExpression(null, filterTable, subquery, null);
    else
        main = new thingtalk_1.Ast.FilterExpression(null, filterTable, subquery, null);
    return new thingtalk_1.Ast.Program(null, [], [], [new thingtalk_1.Ast.ExpressionStatement(null, main)]);
}
/**
 * A shortcut for creating a program with subquery verification
 * @param main the main query
 * @param subqueries the boolean expressions to verify
 */
function makeSubqueryVerificationProgram(main, subqueries) {
    (0, assert_1.default)(subqueries.length > 0);
    const verification = subqueries.length === 1 ? subqueries[0] : new thingtalk_1.Ast.AndBooleanExpression(null, subqueries);
    const expression = new thingtalk_1.Ast.BooleanQuestionExpression(null, main, verification, null);
    return new thingtalk_1.Ast.Program(null, [], [], [new thingtalk_1.Ast.ExpressionStatement(null, expression)]);
}
/**
 * Get the element type of a ThingTalk type
 * @param type a ThingTalk type
 */
function elemType(type) {
    while (type instanceof thingtalk_1.Type.Array)
        type = type.elem;
    return type;
}
/**
 * Handle a few special cases for union clause
 * case 1: { ?s ?p ?o } union { ?s ?p/P17 ?o } ==> { ?s ?p ?o }
 * @param predicate A predicate
 * @returns a parsed triple for the special cases, and false if not matched
 */
function parseSpecialUnion(union) {
    const SPECIAL_PREDICATE = [
        'P17' // country
    ];
    if (union.patterns.length !== 2)
        return false;
    if (union.patterns[0].type !== 'bgp' || union.patterns[1].type !== 'bgp')
        return false;
    if (union.patterns[0].triples.length !== 1 || union.patterns[1].triples.length !== 1)
        return false;
    const first = union.patterns[0].triples[0];
    const second = union.patterns[1].triples[0];
    if (!(first.subject.value && first.subject.value === second.subject.value))
        return false;
    if (!(first.object.value && first.object.value === second.object.value))
        return false;
    if (!('termType' in first.predicate && first.predicate.termType === 'NamedNode'))
        return false;
    if (!('type' in second.predicate && second.predicate.type === 'path' && second.predicate.pathType === '/'))
        return false;
    if (second.predicate.items.length !== 2)
        return false;
    if (!('termType' in second.predicate.items[0] && second.predicate.items[0].termType === 'NamedNode'))
        return false;
    if (!('termType' in second.predicate.items[1] && second.predicate.items[1].termType === 'NamedNode'))
        return false;
    if (second.predicate.items[0].value !== first.predicate.value)
        return false;
    if (!SPECIAL_PREDICATE.includes(second.predicate.items[1].value.slice(wikidata_2.PROPERTY_PREFIX.length)))
        return false;
    return first;
}
/**
 * Get property in predicate with some special cases handling
 * case 1: P131+ ==> P131
 * @param predicate A predicate
 * @returns the property in the predicate
 */
function extractPredicate(predicate) {
    if ('value' in predicate)
        return predicate.value;
    if (predicate.type === 'path' && predicate.pathType === '+') {
        if (predicate.items.length !== 1)
            return null;
        const p = predicate.items[0];
        if ('value' in p && p.value === `${wikidata_2.PROPERTY_PREFIX}P131`)
            return p.value;
    }
    return null;
}
/**
 * A class to retrieve schema information from the schema
 */
class WikiSchema {
    constructor(schema) {
        this._tableMap = {};
        this._propertyMap = {};
        this._propertyTypeMap = {};
        for (const [qname, query] of Object.entries(schema.queries)) {
            const qid = (query.getImplementationAnnotation('wikidata_subject'))[0];
            this._tableMap[qid] = qname;
            for (const arg of query.iterateArguments()) {
                if (arg.name === 'id')
                    continue;
                const pid = arg.getImplementationAnnotation('wikidata_id');
                this._propertyMap[pid] = arg.name;
                this._propertyTypeMap[arg.name] = arg.type;
            }
        }
    }
    /**
     * @param qid QID of a domain
     * @returns the table name (cleaned label of the QID)
     */
    getTable(qid) {
        return this._tableMap[qid];
    }
    /**
     * @param pid PID of a property
     * @returns the property name (cleaned label of the PID)
     */
    getProperty(pid) {
        return this._propertyMap[pid];
    }
    /**
     * @param property the name of the property
     * @returns the entity type of the property
     */
    getPropertyType(property) {
        return this._propertyTypeMap[property];
    }
}
class SPARQLToThingTalkConverter {
    constructor(classDef, cache) {
        this._schema = new WikiSchema(classDef);
        this._parser = new sparqljs_1.Parser();
        this._wikidata = new wikidata_1.default(cache);
        this._tokenizer = new genie_toolkit_1.I18n.LanguagePack('en').getTokenizer();
        this._tables = {};
        this._keywords = [];
        this._variableCounter = 0;
    }
    /**
     * Initialize a table (in ThingTalk) for a subject (in SPARQL)
     * @param subject the subject of the table, either a variable, or a Wikidata entity
     */
    _initTable(subject) {
        if (!(subject in this._tables))
            this._tables[subject] = { domain: 'entity', projections: [], filters: [], verifications: [] };
    }
    /**
     * Add a filter to a able
     * @param subject the subject, a variable in SPARQL
     * @param filter a filter to add to the subject
     */
    _addFilter(subject, filter) {
        this._initTable(subject);
        this._tables[subject].filters.push(filter);
    }
    /**
     * Add a projection to a table
     * @param subject the subject, either a variable, or an entity
     * @param projection a projection to add to the subject
     */
    _addProjection(subject, projection) {
        this._initTable(subject);
        this._tables[subject].projections.push(projection);
    }
    /**
     * Add a verification (boolean question) to a table
     * @param subject the subject, either a variable, or an entity
     * @param verification a verification to add to the subject
     */
    _addVerification(subject, verification) {
        this._initTable(subject);
        this._tables[subject].verifications.push(verification);
    }
    /**
     * Set the domain for a table
     * @param subject the subject, either a variable or an entity
     * @param domain the QID of the domain
     */
    _setDomain(subject, domain) {
        this._initTable(subject);
        this._tables[subject].domain = this._schema.getTable(domain);
    }
    /**
     * @return a new sparqljs compatible variable
     */
    _newVariable() {
        return {
            termType: "Variable",
            value: `v_${this._variableCounter++}`
        };
    }
    /**
     * Convert a value in SPARQL into a ThingTalk value
     * @param value a value in the SPARQL triple
     * @param type the ThingTalk type of the value
     * @returns a ThingTalk value
     */
    async _toThingTalkValue(value, type) {
        if (type instanceof thingtalk_1.Type.Entity) {
            (0, assert_1.default)(typeof value === 'string' && value.startsWith(wikidata_2.ENTITY_PREFIX));
            value = value.slice(wikidata_2.ENTITY_PREFIX.length);
            if (qald_1.ENTITY_SPAN_OVERRIDE[value])
                return new thingtalk_1.Ast.Value.Entity(value, type.type, qald_1.ENTITY_SPAN_OVERRIDE[value]);
            const wikidataLabel = await this._wikidata.getLabel(value);
            (0, assert_1.default)(wikidataLabel);
            const display = (0, misc_1.closest)(wikidataLabel, this._keywords);
            if (!display)
                throw new Error(`Failed find matching span for entity ${value} : ${wikidataLabel} among ${this._keywords}`);
            return new thingtalk_1.Ast.Value.Entity(value, type.type, display);
        }
        if (type === thingtalk_1.Type.Number)
            return new thingtalk_1.Ast.Value.Number(parseFloat(value));
        if (type === thingtalk_1.Type.String)
            return new thingtalk_1.Ast.Value.String(value);
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
    async _atomFilter(property, value, operator, valueType) {
        let propertyLabel, propertyType;
        if (property === 'id') {
            propertyLabel = property;
            propertyType = new thingtalk_1.Type.Entity('org.wikidata:entity');
        }
        else {
            if (property.startsWith(wikidata_2.PROPERTY_PREFIX)) {
                property = property.slice(wikidata_2.PROPERTY_PREFIX.length);
                propertyLabel = this._schema.getProperty(property);
            }
            else {
                propertyLabel = property;
            }
            propertyType = this._schema.getPropertyType(propertyLabel);
        }
        if (operator === '>' || operator === '<')
            operator = operator + '=';
        return new thingtalk_1.Ast.AtomBooleanExpression(null, propertyLabel, operator !== null && operator !== void 0 ? operator : (propertyType instanceof thingtalk_1.Type.Array ? 'contains' : '=='), await this._toThingTalkValue(value, valueType !== null && valueType !== void 0 ? valueType : elemType(propertyType)), null);
    }
    _aggregateFilter(aggregation, operands, operator, value) {
        if (operator === '>' || operator === '<')
            operator = operator + '=';
        return new thingtalk_1.Ast.ComputeBooleanExpression(null, new thingtalk_1.Ast.ComputationValue(aggregation, operands.map((op) => new thingtalk_1.Ast.Value.VarRef(op))), operator, new thingtalk_1.Ast.Value.Number(value));
    }
    async _convertSequencePathTriple(triple, filtersBySubject) {
        const predicates = triple.predicate.items;
        if (predicates.length > 2)
            throw new Error(`Unsupported triple with a 3+ length path:  ${JSON.stringify(triple)}`);
        const variable = this._newVariable();
        await this._convertBasicTriple({ subject: triple.subject, predicate: predicates[0], object: variable }, filtersBySubject);
        await this._convertBasicTriple({ subject: variable, predicate: predicates[1], object: triple.object }, filtersBySubject);
    }
    async _convertBasicTriple(triple, filtersBySubject) {
        const subject = triple.subject.value;
        const predicate = extractPredicate(triple.predicate);
        const object = triple.object.value;
        if (!subject || !predicate || !object)
            throw new Error(`Unsupported triple: ${JSON.stringify(triple)}`);
        // if subject is an entity, create an id filter first
        if (triple.subject.termType === 'NamedNode' && subject.startsWith(wikidata_2.ENTITY_PREFIX))
            this._addFilter(subject, await this._atomFilter('id', subject));
        // if subject is an variable and object is an entity, create a regular filter
        if (triple.subject.termType === 'Variable' && triple.object.termType === 'NamedNode') {
            // for P31 triple, update the domain of the variable, do not add filter
            if (triple.predicate.termType === 'NamedNode' && predicate === `${wikidata_2.PROPERTY_PREFIX}P31`) {
                this._setDomain(subject, object.slice(wikidata_2.ENTITY_PREFIX.length));
                return;
            }
            if (!(subject in filtersBySubject))
                filtersBySubject[subject] = [];
            filtersBySubject[subject].push(await this._atomFilter(predicate, object));
        }
        // if object is an variable, create a projection
        if (triple.object.termType === 'Variable') {
            // if predicate is label, add a new projection with suffix "Label" for the property
            if (predicate === wikidata_2.LABEL) {
                for (const [subj, table] of Object.entries(this._tables)) {
                    const projection = table.projections.find((proj) => proj.variable === subject);
                    if (projection) {
                        this._addProjection(subj, { variable: object, property: projection.property + 'Label' });
                        break;
                    }
                }
            }
            else {
                const property = this._schema.getProperty(predicate.slice(wikidata_2.PROPERTY_PREFIX.length));
                this._addProjection(subject, { variable: object, property });
            }
        }
        // if both subject and object are entities, create a "verification", for boolean question
        if (triple.subject.termType === 'NamedNode' && triple.object.termType === 'NamedNode')
            this._addVerification(subject, await this._atomFilter(predicate, object));
    }
    /**
     * Convert RDF triples into thingtalk filters by subjects
     * @param triples RDF Triples derived from SPARQL
     * @returns a map from subjects to their ThingTalk filters converted from the triples
     */
    async _convertTriples(triples) {
        const filtersBySubject = {};
        for (const triple of triples) {
            if ('type' in triple.predicate && triple.predicate.type === 'path' && triple.predicate.pathType === '/')
                await this._convertSequencePathTriple(triple, filtersBySubject);
            else
                await this._convertBasicTriple(triple, filtersBySubject);
        }
        const converted = {};
        for (const [subject, filters] of Object.entries(filtersBySubject))
            converted[subject] = filters.length === 1 ? filters[0] : new thingtalk_1.Ast.AndBooleanExpression(null, filters);
        return converted;
    }
    /**
     * Parse a union where clause
     * @param where a where clause
     */
    async _parseUnion(where) {
        const triple = parseSpecialUnion(where);
        if (triple) {
            await this._parseBasic({ triples: [triple] });
            return;
        }
        let existedSubject;
        const operands = [];
        for (const pattern of where.patterns) {
            (0, assert_1.default)(pattern.type === 'bgp');
            const filtersBySubject = await this._convertTriples(pattern.triples);
            for (const [subject, filter] of Object.entries(filtersBySubject)) {
                if (!existedSubject)
                    existedSubject = subject;
                else if (subject !== existedSubject)
                    throw new Error(`Multiple subject in filter ${where.patterns}`);
                operands.push(filter);
            }
        }
        this._addFilter(existedSubject, new thingtalk_1.Ast.OrBooleanExpression(null, operands));
    }
    /**
     * Parse a filter clause
     * @param filter a filter clause
     * @param isVerification if it's a verification question or not
     */
    async _parseFilter(filter, isVerification) {
        const expression = filter.expression;
        (0, assert_1.default)(filter.type === 'filter' && expression.args.length === 2);
        const [lhs, rhs] = expression.args;
        (0, assert_1.default)(lhs.termType === 'Variable' && rhs.termType === 'Literal');
        for (const [subject, table] of Object.entries(this._tables)) {
            const projection = table.projections.find((proj) => proj.variable === lhs.value);
            if (!projection)
                continue;
            let booleanExpression;
            if (projection.property.endsWith('Label')) {
                (0, assert_1.default)(expression.operator === 'regex');
                const property = projection.property.slice(0, -'Label'.length);
                const propertyType = this._schema.getPropertyType(property);
                const operator = (propertyType instanceof thingtalk_1.Type.Array) ? 'contains~' : '=~';
                booleanExpression = await this._atomFilter(property, rhs.value, operator, thingtalk_1.Type.String);
            }
            else {
                booleanExpression = await this._atomFilter(projection.property, rhs.value, expression.operator, thingtalk_1.Type.Number);
            }
            if (isVerification)
                this._addVerification(subject, booleanExpression);
            else
                this._addFilter(subject, booleanExpression);
        }
    }
    /**
     * Parse a basic triple where clause
     * @param where a where clause
     */
    async _parseBasic(where) {
        const filtersBySubject = await this._convertTriples(where.triples);
        for (const [subject, filter] of Object.entries(filtersBySubject))
            this._addFilter(subject, filter);
    }
    /**
     * Parse a where clause
     * @param where a where clause
     * @param isVerification if it's a verification question or not
     */
    async _parseWhereClause(where, isVerification) {
        if (where.type === 'bgp')
            await this._parseBasic(where);
        else if (where.type === 'union')
            await this._parseUnion(where);
        else if (where.type === 'filter')
            await this._parseFilter(where, isVerification);
        else
            throw new Error(`Unsupported filter ${JSON.stringify(where)}`);
    }
    async _parseHavingClause(having, group) {
        (0, assert_1.default)(group.expression && group.expression.termType === 'Variable');
        const subject = group.expression.value;
        if (!(subject in this._tables))
            throw new Error('Unsupported group by operation on object');
        if (having.type === 'operation') {
            (0, assert_1.default)(having.args.length === 2);
            const [lhs, rhs] = having.args;
            (0, assert_1.default)(lhs.type === 'aggregate' && !lhs.distinct && lhs.aggregation === 'count' && lhs.expression.termType === 'Variable');
            const variable = lhs.expression.value;
            const projection = this._tables[subject].projections.find((proj) => proj.variable === variable);
            if (!projection)
                throw new Error(`Can't find matching variable for the having clause`);
            (0, assert_1.default)(rhs.termType === 'Literal' && !isNaN(rhs.value));
            this._addFilter(subject, this._aggregateFilter('count', [projection.property], having.operator, parseFloat(rhs.value)));
        }
        else {
            throw new Error(`Unsupported having clause ${JSON.stringify(having)}`);
        }
    }
    /**
     * reset tables used to track the conversion
     */
    _reset(keywords) {
        this._tables = {};
        this._keywords = keywords.map((keyword) => this._tokenizer.tokenize(keyword).rawTokens.join(' '));
    }
    /**
     * Convert SPARQL into ThingTalk
     * @param sparql a string of SPARQL query
     * @param keywords a list of keywords in the utterance including the mentioned entities
     * @returns A ThingTalk Program
     */
    async convert(sparql, keywords) {
        var _a, _b;
        this._reset(keywords);
        const parsed = this._parser.parse(sparql);
        if (parsed.where) {
            for (const clause of parsed.where)
                await this._parseWhereClause(clause, parsed.queryType === 'ASK');
        }
        if ('having' in parsed && 'group' in parsed) {
            (0, assert_1.default)(parsed.group.length === 1);
            for (const clause of (_a = parsed.having) !== null && _a !== void 0 ? _a : [])
                await this._parseHavingClause(clause, parsed.group[0]);
        }
        const queries = {}; // subject : query
        const aggregation = {}; // aggregation type : aggregation subject
        const variables = [];
        if ('variables' in parsed) {
            for (const variable of (_b = parsed.variables) !== null && _b !== void 0 ? _b : []) {
                if ('value' in variable && variable.value !== '*') {
                    variables.push(variable.value);
                }
                else if ('expression' in variable && 'type' in variable.expression && variable.expression.type === 'aggregate') {
                    (0, assert_1.default)(variable.expression.aggregation === 'count');
                    const expression = variable.expression.expression;
                    (0, assert_1.default)('termType' in expression && expression.termType === 'Variable');
                    aggregation.count = expression.value;
                }
                else {
                    throw new Error(`Unsupported variable type: ${variable}`);
                }
            }
        }
        for (const [subject, table] of Object.entries(this._tables)) {
            // handle filters
            let query = baseQuery(table.domain);
            if (table.filters.length > 0)
                query = new thingtalk_1.Ast.FilterExpression(null, query, new thingtalk_1.Ast.BooleanExpression.And(null, table.filters), null);
            // handle aggregation count
            // if there is a count aggregation, projection/verification/sorting makes no sense
            // finish this table and continue
            if (aggregation.count && aggregation.count === subject) {
                query = new thingtalk_1.Ast.AggregationExpression(null, query, '*', 'count', null);
                queries[subject] = query;
                continue;
            }
            // handle projections and verifications
            const projections = [];
            if (variables.includes(subject))
                projections.push('id');
            for (const projection of table.projections) {
                if (variables.includes(projection.variable) || Object.keys(this._tables).includes(projection.variable))
                    projections.push(projection.property);
            }
            if (parsed.queryType === 'ASK' && table.verifications.length > 0) {
                (0, assert_1.default)(projections.length === 0);
                const verification = table.verifications.length > 1 ? new thingtalk_1.Ast.AndBooleanExpression(null, table.verifications) : table.verifications[0];
                query = new thingtalk_1.Ast.BooleanQuestionExpression(null, query, verification, null);
            }
            else if (parsed.queryType === 'SELECT') {
                // if it's not a verification question, and there is no projection/verification 
                // for a table, skip the table - it's a helper table to generate filter
                if (projections.length === 0)
                    continue;
                if (!(projections.length === 1 && projections[0] === 'id'))
                    query = new thingtalk_1.Ast.ProjectionExpression(null, query, projections, [], [], null);
            }
            // handle sorting
            if ('order' in parsed) {
                (0, assert_1.default)(parsed.order.length === 1);
                const expression = parsed.order[0].expression;
                (0, assert_1.default)('termType' in expression && expression.termType === 'Variable');
                const projection = table.projections.find((proj) => proj.variable === expression.value);
                if (projection) {
                    const property = new thingtalk_1.Ast.Value.VarRef(projection.property);
                    const direction = parsed.order[0].descending ? 'desc' : 'asc';
                    query = new thingtalk_1.Ast.SortExpression(null, query, property, direction, null);
                    if (parsed.limit)
                        query = new thingtalk_1.Ast.IndexExpression(null, query, [new thingtalk_1.Ast.Value.Number(parsed.limit)], null);
                }
            }
            queries[subject] = query;
        }
        if (Object.values(queries).length === 1) {
            const query = Object.values(queries)[0];
            if (parsed.queryType === 'ASK' && !(query instanceof thingtalk_1.Ast.BooleanQuestionExpression))
                throw new Error(`Unsupported command: verification question on if the result is empty or not: ${sparql}`);
            return makeProgram(Object.values(queries)[0]);
        }
        if (Object.values(queries).length === 2 && parsed.queryType === 'SELECT') {
            let [[mainSubject, main], [subquerySubject, subquery]] = Object.entries(queries);
            // the query without any projection in SPARQL variables should be the subquery
            // swap if necessary
            if (!this._tables[mainSubject].projections.some((proj) => variables.includes(proj.variable)))
                [mainSubject, main, subquerySubject, subquery] = [subquerySubject, subquery, mainSubject, main];
            // verify 
            if (!this._tables[mainSubject].projections.some((proj) => variables.includes(proj.variable)))
                throw new Error(`Failed to identify main query in ${sparql}`);
            if (this._tables[subquerySubject].projections.some((proj) => variables.includes(proj.variable)))
                throw new Error(`Failed to identify subquery in ${sparql}.`);
            let subqueryFilter;
            if (this._tables[mainSubject].projections.some((proj) => proj.variable === subquerySubject)) {
                const projection = this._tables[mainSubject].projections.find((proj) => proj.variable === subquerySubject);
                const property = projection.property;
                subqueryFilter = new thingtalk_1.Ast.ComparisonSubqueryBooleanExpression(null, new thingtalk_1.Ast.Value.VarRef(property), this._schema.getPropertyType(property) instanceof thingtalk_1.Type.Array ? 'contains' : '==', new thingtalk_1.Ast.ProjectionExpression(null, subquery, ['id'], [], [], null), null);
            }
            else if (this._tables[subquerySubject].projections.some((proj) => proj.variable === mainSubject)) {
                const projection = this._tables[subquerySubject].projections.find((proj) => proj.variable === mainSubject);
                const property = projection.property;
                subqueryFilter = new thingtalk_1.Ast.ComparisonSubqueryBooleanExpression(null, new thingtalk_1.Ast.Value.VarRef('id'), this._schema.getPropertyType(property) instanceof thingtalk_1.Type.Array ? 'in_array' : '==', subquery, null);
            }
            else {
                throw new Error(`Failed to identify main & subquery in ${sparql}`);
            }
            return makeSubqueryProgram(main, subqueryFilter);
        }
        if (Object.values(queries).length >= 2 && parsed.queryType === 'ASK') {
            const mainSubject = Object.keys(queries).find((subject) => subject.startsWith(wikidata_2.ENTITY_PREFIX));
            if (!mainSubject)
                throw new Error('No main function found');
            const main = queries[mainSubject];
            const subqueries = [];
            for (const [subject, query] of Object.entries(queries)) {
                if (subject === mainSubject)
                    continue;
                const proj = this._tables[mainSubject].projections.find((proj) => proj.variable === subject);
                if (!proj)
                    throw new Error(`No supported verification question: ${sparql}`);
                subqueries.push(new thingtalk_1.Ast.ComparisonSubqueryBooleanExpression(null, new thingtalk_1.Ast.Value.VarRef(proj.property), this._schema.getPropertyType(proj.property) instanceof thingtalk_1.Type.Array ? 'contains' : '==', query, null));
            }
            return makeSubqueryVerificationProgram(main, subqueries);
        }
        throw new Error(`Not supported by ThingTalk: ${sparql}`);
    }
}
exports.default = SPARQLToThingTalkConverter;
async function main() {
    const parser = new argparse.ArgumentParser({
        add_help: true,
        description: "A tool to convert QALD-7 SPARQL to ThingTalk"
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
    const args = parser.parse_args();
    const manifest = await fs_1.promises.readFile(args.manifest, { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: args.locale, timezone: args.timezone });
    (0, assert_1.default)(library instanceof ThingTalk.Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new SPARQLToThingTalkConverter(classDef, args.cache);
    const tokenizer = new genie_toolkit_1.I18n.LanguagePack('en').getTokenizer();
    const input = args.input.pipe(JSONStream_1.default.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
    const output = new genie_toolkit_1.DatasetStringifier();
    output.pipe(args.output);
    for await (const item of input) {
        const preprocessed = tokenizer.tokenize(item.question[0].string).rawTokens.join(' ');
        try {
            const program = await converter.convert(item.query.sparql, item.question[0].keywords.split(', '));
            const target_code = genie_toolkit_1.ThingTalkUtils.serializePrediction(program, preprocessed, genie_toolkit_1.EntityUtils.makeDummyEntities(preprocessed), { locale: 'en', timezone: undefined, includeEntityValue: true }).join(' ');
            output.write({ id: item.id, preprocessed, target_code });
        }
        catch (e) {
            console.log(`Example ${item.id} failed`);
            if (args.drop)
                args.drop.write(`${item.id}\t${preprocessed}\t${item.query.sparql}\t${e.message.replace(/\s+/g, ' ')}`);
        }
    }
    await (0, misc_1.waitFinish)(input);
    await (0, misc_1.waitFinish)(output);
    if (args.drop)
        await (0, misc_1.waitFinish)(args.drop);
}
if (require.main === module)
    main();
//# sourceMappingURL=converter.js.map