import assert from 'assert';
import { EntityUtils } from 'genie-toolkit';
import ThingTalk, { Type } from 'thingtalk';
import { Ast, Syntax } from "thingtalk";
import WikidataUtils from '../utils/wikidata';
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

const ENTITY_VARIABLES = ['x', 'y', 'z'];
const PREDICATE_VARIABLES = ['p', 'q', 'r'];

function convertOp(op : string) {
    // HACK
    return ['>=', '<='].includes(op) ? op[0] : op; 
}

class TableInfoVisitor extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    subject ?: string;
    domainName ?: string;

    constructor(converter : ThingTalkToSPARQLConverter) {
        super();
        this._converter = converter;
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
            this.domainName = node.value.value!;
        return true;
    }

    visitInvocation(node : ThingTalk.Ast.Invocation) : boolean {
        if (node.channel !== 'entity') {
            if (this._converter.humanReadableInstanceOf) {
                this.domainName = node.channel.replace(/_/g, ' ');
            } else {
                const query = this._converter.class.getFunction('query', node.channel);
                this.domainName = (query?.getImplementationAnnotation('wikidata_subject') as string[])[0];
            } 
        }
        return true;
    }

    visitComparisonSubqueryBooleanExpression(node : ThingTalk.Ast.ComparisonSubqueryBooleanExpression) : boolean {
        return false;
    }
}

interface QualifiedPredicate {
    property : string;
    predicateVariable : string;
}


class TripleGenerator extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    private _subject : string;
    private _target_projection : string|null;
    private _inPredicate : QualifiedPredicate|null;

    constructor(converter : ThingTalkToSPARQLConverter, 
                subject : string, 
                projection : string|null, 
                domain : string|null,
                qualifiedPredicate : QualifiedPredicate|null = null) {
        super();
        this._converter = converter;
        this._subject = subject;
        this._target_projection = projection;
        this._inPredicate = qualifiedPredicate;
        if (subject.startsWith('?') && domain)
            this._converter.addStatement(this._triple('P31', domain));
    }

    private _triple(property : string, value : string, subject ?: string) {
        let s = this._subject;
        if (subject && [...ENTITY_VARIABLES, ...PREDICATE_VARIABLES].includes(subject))
            s = `?${subject}`;
        else if (subject)
            s = `<${ENTITY_PREFIX}${subject}>`;
        let p;
        if (this._inPredicate)
            p = property === 'value' ? `<${PROPERTY_STATEMENT_PREFIX}${this._inPredicate.property}>` : `<${PROPERTY_QUALIFIER_PREFIX}${property}>`;
        else   
            p = PREDICATE_VARIABLES.includes(value) ? `<${PROPERTY_PREDICATE_PREFIX}${property}>` : `<${PROPERTY_PREFIX}${property}>`;
        const v = [...ENTITY_VARIABLES, ...PREDICATE_VARIABLES].includes(value) ? `?${value}` : `<${ENTITY_PREFIX}${value}>`;
        return `${s} ${p} ${v}.`;
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        assert(node.args.length === 1 || node.computations.length === 1);
        if (node.args.length === 1) {
            const arg = node.args[0];
            if (arg === 'id')
                return true;
            const p = this._converter.getWikidataProperty(arg);
            const v = this._converter.getEntityVariable(p);
            if (arg === this._target_projection) 
                this._converter.setResultVariable(`?${v}`);
            this._converter.addStatement(this._triple(p, v));
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
            this._converter.setResultVariable(`?${v}`);
        
        if (Array.isArray(proj.value)) {
            const path : string[] = [];
            for (const element of proj.value) {
                const property = this._converter.getWikidataProperty(element.property);
                path.push(`<${PROPERTY_PREFIX}${property}>${element.quantifier ?? ''}`);
            }
            this._converter.addStatement(`${this._subject} ${path.join('/')} ?${v}.`);
        } else {
            const p = this._converter.getWikidataProperty(proj.value);
            this._converter.addStatement(this._triple(p, v));
        }     

        if (proj.types.length > 0) {
            const statements = proj.types.map((t) => {
                const type = (t as Type.Entity).type.slice(TP_DEVICE_NAME.length + 1).replace(/_/g, ' ');
                const domain = this._converter.getWikidataDomain(type)!;
                return this._triple('P31', domain, v);
            });
            if (statements.length === 1)
                this._converter.addStatement(statements[0]);
            else 
                this._converter.addStatement(`{ ${statements.join(' UNION ')} }`);
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
                this._converter.addStatement(this._triple(p, v));
                return false; 
            } 
        }
        throw new Error('Unsupported negative boolean expression');
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        // id string filter
        if (node.name === 'id' && node.operator === '=~') {
            assert(node.value instanceof Ast.StringValue);
            this._converter.addStatement(`${this._subject} <${LABEL}> "${node.value.value}"@en.`);
            return true;
        }

        // skip all other filters on id and instance_of
        if (node.name === 'id' || node.name === 'instance_of')
            return true;

        // filter on aggregation result
        if (node.name === 'count') {
            assert(node.value instanceof Ast.NumberValue);
            // check if any node satisfying the filters exists, no need to do anything
            if (node.value.value === 1 && node.operator === '>=')
                return true;
            throw new Error('Unsupported aggregation');
        } 


        // generic atom filters 
        let p = node.name;
        if (!(node.name === 'value' && this._inPredicate)) {
            const property = node.name;
            p = this._converter.getWikidataProperty(property);
        }
        if (node.value instanceof Ast.EntityValue) {
            const v = node.value.value!;
            this._converter.addStatement(this._triple(p, v));
        } else if (node.value instanceof Ast.NumberValue) {
            const value = node.value.value;
            const variable = this._converter.getEntityVariable(p);
            this._converter.addStatement(this._triple(p, variable));
            this._converter.addStatement(`FILTER(?${variable} ${convertOp(node.operator)} ${value}).`);
        } else if (node.value instanceof Ast.DateValue) {
            const value = (node.value.toJS() as Date).toISOString();
            const variable = this._converter.getEntityVariable(p);
            this._converter.addStatement(this._triple(p, variable));
            this._converter.addStatement(`FILTER(?${variable} ${convertOp(node.operator)} "${value}"^^<${DATETIME}>).`);
        } else if (node.value instanceof Ast.StringValue) {
            const value = node.value.value;
            const variable = this._converter.getEntityVariable(p);
            this._converter.addStatement(this._triple(p, variable));
            this._converter.addStatement(`?${variable} <${LABEL}> "${value}"@en.`);
        } else {
            throw new Error('Unsupported atom filter');
        }
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
                this._converter.addStatement(this._triple(p, variable));
                if (!(node.operator === '>=' && value === 1)) // this means it is just checking if anything exists, no need to use having clause
                    this._converter.addHaving(`COUNT(?${variable}) ${op} ${value}`);
                return true;
            }
        }
        throw new Error('Unsupported compute boolean expression: ' + node.prettyprint());
    }

    visitIndexExpression(node : ThingTalk.Ast.IndexExpression) : boolean {
        assert(node.indices.length === 1 && (node.indices[0] as Ast.NumberValue).value === 1);
        this._converter.setLimit(1);
        return true;
    }

    visitSliceExpression(node : ThingTalk.Ast.SliceExpression) : boolean {
        assert((node.base as Ast.NumberValue).value === 1);
        this._converter.setLimit((node.limit as Ast.NumberValue).value);
        return true;
    }

    visitSortExpression(node : ThingTalk.Ast.SortExpression) : boolean {
        const property = (node.value as Ast.VarRefValue).name;
        const p = this._converter.getWikidataProperty(property);
        const variable = this._converter.getEntityVariable(p);
        this._converter.addStatement(this._triple(p, variable));
        this._converter.setOrder({ variable : '?' + variable, direction: node.direction });
        return true;
    }

    visitAggregationExpression(node : ThingTalk.Ast.AggregationExpression) : boolean {
        if (node.operator === 'count' && node.field === '*') {
            this._converter.setAggregation(node.operator, this._subject.slice('?'.length));
        } else {
            const property = this._converter.getWikidataProperty(node.field);
            const v = this._converter.getEntityVariable(node.field);
            this._converter.setAggregation(node.operator, v);
            this._converter.addStatement(this._triple(property, v));
        }
        return true;
    }

    visitPropertyPathBooleanExpression(node : ThingTalk.Ast.PropertyPathBooleanExpression) : boolean {
        const predicate = node.path.map((elem) => {
            const p = this._converter.getWikidataProperty(elem.property);
            return elem.quantifier ? `<${PROPERTY_PREFIX}${p}>${elem.quantifier}` : `<${PROPERTY_PREFIX}${p}>`;
        }).join('/'); 
        const v = (node.value as Ast.EntityValue).value!;
        this._converter.addStatement(`${this._subject} ${predicate} <${ENTITY_PREFIX}${v}>.`);
        return true;
    }

    // qualifier
    visitFilterValue(node : ThingTalk.Ast.FilterValue) : boolean {
        assert(node.value instanceof Ast.VarRefValue);
        const predicate = this._createQualifier(node.value.name);
        const entityVariable = this._converter.getEntityVariable();
        this._converter.addStatement(`?${predicate.predicateVariable} <${PROPERTY_STATEMENT_PREFIX}${predicate.property}> ?${entityVariable}.`);
        const tripleGenerator = new TripleGenerator(this._converter, `?${predicate.predicateVariable}`, null, null, predicate);
        node.filter.visit(tripleGenerator);

        if (node.prettyprint() === this._target_projection)
            this._converter.setResultVariable(`?${entityVariable}`);
        return false;
    }

    visitArrayFieldValue(node : ThingTalk.Ast.ArrayFieldValue) : boolean {
        assert(node.value instanceof Ast.FilterValue && node.value.value instanceof Ast.VarRefValue);
        const predicate = this._createQualifier(node.value.value.name);
        const field = this._converter.getWikidataProperty(node.field);
        const fieldVariable = this._converter.getEntityVariable(field);
        this._converter.addStatement(`?${predicate.predicateVariable} <${PROPERTY_QUALIFIER_PREFIX}${field}> ?${fieldVariable}.`);
        const tripleGenerator = new TripleGenerator(this._converter, `?${predicate.predicateVariable}`, null, null, predicate);
        node.value.filter.visit(tripleGenerator);

        if (node.prettyprint() === this._target_projection)
            this._converter.setResultVariable(`?${fieldVariable}`);
        return false;
    }

    private _createQualifier(property : string) : QualifiedPredicate {
        const p = this._converter.getWikidataProperty(property);
        const predicateVariable = this._converter.getPredicateVariable();
        this._converter.addStatement(this._triple(p, predicateVariable));
        return {
            property : p,
            predicateVariable
        };
    }

    visitComparisonSubqueryBooleanExpression(node : ThingTalk.Ast.ComparisonSubqueryBooleanExpression) : boolean {
        assert(node.lhs instanceof Ast.VarRefValue);
        const p = this._converter.getWikidataProperty(node.lhs.name);
        const v = this._converter.getEntityVariable(p);
        this._converter.addStatement(this._triple(p, v));

        // set variable map for the subquery (do not use existing mapping)
        const variableMap : Record<string, string> = {};
        let projection  = (node.rhs as Ast.ProjectionExpression).args[0];
        if (projection === 'id') {
            variableMap[projection] = v;
        } else {
            projection = this._converter.getWikidataProperty(projection);
            variableMap[projection] = this._converter.getEntityVariable();
        }
        
        if (node.operator === '==' || node.operator === 'contains' || node.operator === 'in_array') {
            this._converter.convertExpression(node.rhs.optimize(), false, variableMap);
        } else if (node.operator === '>=' || node.operator === '<=' ) {
            this._converter.convertExpression(node.rhs.optimize(), false, variableMap);
            this._converter.addStatement(`FILTER(?${v} ${node.operator[0]} ?${variableMap[projection]}).`);
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
    bootleg : string,
    human_readable_instance_of : boolean
}
export default class ThingTalkToSPARQLConverter {
    private _classDef : Ast.ClassDef;
    private _locale : string;
    private _timezone ?: string;
    private _kb : WikidataUtils;
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
    private _aggregation : Aggregation|null;
    private _humanReadableInstanceOf : boolean;

    constructor(classDef : Ast.ClassDef, entities : Entity[], options : ThingTalkToSPARQLConverterOptions) {
        this._classDef = classDef;
        this._locale = options.locale;
        this._timezone = options.timezone;

        this._kb = new WikidataUtils(options.cache, options.bootleg);
        this._propertyMap = { "P31" : "instance_of" };
        for (const property of this._classDef.queries['entity'].iterateArguments()) {
            const qid = property.getImplementationAnnotation('wikidata_id') as string;
            this._propertyMap[property.name] = qid;
        }
        this._domainMap = { 'art museum' : 'Q207694' };
        for (const entity of entities) {
            const qid = entity.name.match(/Q[0-9]+/g)![0];
            this._domainMap[entity.value] = qid;
            this._domainMap[qid] = qid;
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
        if (domain in this._domainMap)
            return this._domainMap[domain];
        if (this._kb.isEntity(domain))
            return domain;
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
        this._resultVariable = null;
        this._isBooleanQuestion = false;
        this._aggregation = null;
        this._variableMap = {};
    }

    private _targetProjectionName(ast : Ast.Expression) {
        if (ast instanceof Ast.ProjectionExpression) {
            assert(ast.args.length === 1 || ast.computations.length === 1);
            if (ast.args.length === 1) 
                return ast.args[0];
            if (ast.computations.length === 1)
                return ast.computations[0].prettyprint();
        }
        if (ast instanceof Ast.ProjectionExpression2) {
            assert(ast.projections.length === 1);
            return ast.projections[0].prettyprint();
        }
        return null;
    }

    async convertExpression(ast : Ast.Expression, isMainExpression = true, variableMapping : Record<string, string> = {}) {
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
                subject = '?' + this._variableMap['id'];
            else 
                subject = '?' + this.getEntityVariable();
        }
        if (isMainExpression && subject.startsWith('?'))
            this.setResultVariable(subject);
        const domain = tableInfoVisitor.domainName ? await this.getWikidataDomain(tableInfoVisitor.domainName) : null;
        this._variableMap = variableMapping;
        const tripleGenerator = new TripleGenerator(this, subject, isMainExpression ? this._targetProjectionName(ast) : null, domain);
        ast.visit(tripleGenerator);

        // restore out of scope variable
        this._variableMap = outVariableMapping;
    }

    async convert(utterance : string, thingtalk : string) : Promise<string> {
        this._reset();
        const entities = EntityUtils.makeDummyEntities(utterance);
        const ast = Syntax.parse(thingtalk, Syntax.SyntaxType.Tokenized, entities, {
            locale : this._locale, timezone: this._timezone
        });
        assert(ast instanceof Ast.Program);
        const expr = (ast.statements[0] as Ast.ExpressionStatement).expression;
        assert(expr instanceof Ast.ChainExpression && expr.expressions.length === 1);
        const table = expr.expressions[0];
        await this.convertExpression(table);  

        let sparql = '';
        // ask/select
        if (this._isBooleanQuestion) 
            sparql += 'ASK '; 
        else if (this._aggregation) 
            sparql += `SELECT ${aggregationToString(this._aggregation)} `;
        else  
            sparql += `SELECT DISTINCT ${this._resultVariable} `;

        // where clauses
        sparql += `WHERE { ${this._statements.join((' '))} }`;

        // having clauses
        if (this._having.length > 0)
            sparql += ` GROUP BY ${this._resultVariable} HAVING(${this._having.join(' && ')})`;
        
        // order claueses
        if (this._order)
            sparql += ` ORDER BY ${this._order.direction === 'desc'? `DESC(${this._order.variable})` : this._order.variable}`;
        if (this._limit)
            sparql += ` LIMIT ${this._limit}`;
        return sparql;
    }
}