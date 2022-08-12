import assert from 'assert';
import { EntityUtils } from 'genie-toolkit';
import ThingTalk, { Type } from 'thingtalk';
import { Ast, Syntax } from "thingtalk";
import WikidataUtils from '../utils/wikidata';
import { ENTITY_PREFIX, PROPERTY_PREFIX, LABEL, DATETIME, TP_DEVICE_NAME } from '../utils/wikidata';

const ENTITY_VARIABLES = ['x', 'y', 'z'];
// const PREDICATE_VARIABLES = ['p', 'q', 'r'];

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
        if (this._converter.humanReadableInstanceOf) {
            this.domainName = node.channel.replace(/_/g, ' ');
        } else {
            const query = this._converter.class.getFunction('query', node.channel);
            this.domainName = (query?.getImplementationAnnotation('wikidata_subject') as string[])[0];
        } 
        return true;
    }
}

class TripleGenerator extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    private _subject : string;
    private _target_projection : string|null;

    constructor(converter : ThingTalkToSPARQLConverter, subject : string, projection : string|null, domain : string|null) {
        super();
        this._converter = converter;
        this._subject = subject;
        this._target_projection = projection;
        if (subject.startsWith('?') && domain)
            this._converter.addStatement(`${subject} <${PROPERTY_PREFIX}P31> <${ENTITY_PREFIX}${domain}>.`);
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        assert(node.args.length === 1);
        const arg = node.args[0];
        const p = this._converter.getWikidataProperty(arg);
        const v = this._converter.getEntityVariable();
        if (arg === this._target_projection) 
            this._converter.setResultVariable(`?${v}`);
        this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${v}.`);
        return true;
    }

    visitProjectionExpression2(node : ThingTalk.Ast.ProjectionExpression2) : boolean {
        assert(node.projections.length === 1);
        const proj = node.projections[0];
        if (proj.value instanceof Ast.Value)    
            throw new Error('Not supported: value in projection');
        
        const v = this._converter.getEntityVariable();
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
            this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${v}.`);
        }     

        if (proj.types.length > 0) {
            const statements = proj.types.map((t) => {
                const type = (t as Type.Entity).type.slice(TP_DEVICE_NAME.length + 1).replace(/_/g, ' ');
                const domain = this._converter.getWikidataDomain(type);
                return `?${v} <${PROPERTY_PREFIX}P31> <${ENTITY_PREFIX}${domain}>.`;
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
                const v = this._converter.getEntityVariable();
                this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${v}.`);
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
        const property = node.name;
        const p = this._converter.getWikidataProperty(property);
        if (node.value instanceof Ast.EntityValue) {
            const v = node.value.value!;
            this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> <${ENTITY_PREFIX}${v}>.`);
        } else if (node.value instanceof Ast.NumberValue) {
            const value = node.value.value;
            const variable = this._converter.getEntityVariable();
            this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${variable}.`);
            this._converter.addStatement(`FILTER(?${variable} ${convertOp(node.operator)} ${value}).`);
        } else if (node.value instanceof Ast.DateValue) {
            const value = (node.value.toJS() as Date).toISOString();
            const variable = this._converter.getEntityVariable();
            this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${variable}.`);
            this._converter.addStatement(`FILTER(?${variable} ${convertOp(node.operator)} "${value}"^^<${DATETIME}>).`);
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
                const variable = this._converter.getEntityVariable();
                this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${variable}.`);
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
        const variable = this._converter.getEntityVariable();
        this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${variable}.`);
        this._converter.setOrder({ variable : '?' + variable, direction: node.direction });
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

    private _entityVariableCount : number;
    private _resultVariable : string|null;
    private _isBooleanQuestion : boolean;
    private _statements : string[];
    private _having : string[];
    private _order : Order|null;
    private _limit : number|null;
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
        if (options.human_readable_instance_of) {
            for (const entity of entities) {
                const qid = entity.name.match(/Q[0-9]+/g)![0];
                this._domainMap[entity.value] = qid;
                this._domainMap[qid] = qid;
            }
        }

        this._humanReadableInstanceOf = options.human_readable_instance_of;

        this._entityVariableCount = 0;
        this._statements = [];
        this._having = [];
        this._resultVariable = null;
        this._isBooleanQuestion = false;
        this._order = null;
        this._limit = null;
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

    getEntityVariable() : string {
        return ENTITY_VARIABLES[this._entityVariableCount ++];
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

    private _reset() {
        this._entityVariableCount = 0;
        this._statements = [];
        this._having = [];
        this._order = null;
        this._limit = null;
        this._resultVariable = null;
        this._isBooleanQuestion = false;
    }

    private _targetProjectionName(ast : Ast.Expression) {
        if (ast instanceof Ast.ProjectionExpression) {
            assert(ast.args.length === 1);
            return ast.args[0];
        }
        if (ast instanceof Ast.ProjectionExpression2) {
            assert(ast.projections.length === 1);
            return ast.projections[0].prettyprint();
        }
        return null;
    }

    private async _convertSingleTable(ast : Ast.Expression) {
        const tableInfoVisitor = new TableInfoVisitor(this);
        ast.visit(tableInfoVisitor);
        const subject = tableInfoVisitor.subject ?? '?' + this.getEntityVariable();
        if (subject.startsWith('?'))
            this.setResultVariable(subject);
        const projection = this._targetProjectionName(ast);
        const domain = tableInfoVisitor.domainName ? await this.getWikidataDomain(tableInfoVisitor.domainName) : null;
        const tripleGenerator = new TripleGenerator(this, subject, projection, domain);
        ast.visit(tripleGenerator);
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
        await this._convertSingleTable(table);  
        let sparql = (this._isBooleanQuestion ? `ASK ` : `SELECT DISTINCT ${this._resultVariable} `) + 
            `WHERE { ${this._statements.join((' '))} }`;
        if (this._having.length > 0)
            sparql += ` GROUP BY ${this._resultVariable} HAVING(${this._having.join(' && ')})`;
        if (this._order)
            sparql += ` ORDER BY ${this._order.direction === 'desc'? `DESC(${this._order.variable})` : this._order.variable}`;
        if (this._limit)
            sparql += ` LIMIT ${this._limit}`;
        return sparql;
    }
}