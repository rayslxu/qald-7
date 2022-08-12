import assert from 'assert';
import { EntityUtils } from 'genie-toolkit';
import ThingTalk from 'thingtalk';
import { Ast, Syntax } from "thingtalk";
import WikidataUtils from '../utils/wikidata';
import { ENTITY_PREFIX, PROPERTY_PREFIX } from '../utils/wikidata';

const ENTITY_VARIABLES = ['x', 'y', 'z'];
// const PREDICATE_VARIABLES = ['p', 'q', 'r'];

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
        for (const arg of node.args) {
            const p = this._converter.getWikidataProperty(arg);
            const v = this._converter.getEntityVariable();
            if (arg === this._target_projection) 
                this._converter.setResultVariable(`?${v}`);
            this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${v}.`);
        }
        return true;
    }

    visitProjectionExpression2(node : ThingTalk.Ast.ProjectionExpression2) : boolean {
        for (const proj of node.projections) {
            if (proj.value instanceof Ast.Value)    
                throw new Error('Not supported: value in projection');
            
            if (Array.isArray(proj.value)) {
                const path : string[] = [];
                for (const element of proj.value) {
                    const property = this._converter.getWikidataProperty(element.property);
                    path.push(`<${PROPERTY_PREFIX}${property}>${element.quantifier ?? ''}`);
                }
                const v = this._converter.getEntityVariable();
                this._converter.addStatement(`${this._subject} ${path.join('/')}, ?${v}.`);
            } else {
                const p = this._converter.getWikidataProperty(proj.value);
                const v = this._converter.getEntityVariable();
                this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${v}.`);
            }     
        }
        return true;
    }

    visitBooleanQuestionExpression(node : ThingTalk.Ast.BooleanQuestionExpression) : boolean {
        this._converter.setIsBooleanQuestion();
        return true;
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        if (node.name !== 'id' && node.name !== 'instance_of') {
            const property = node.name;
            const p = this._converter.getWikidataProperty(property);
            const v = (node.value as Ast.EntityValue).value!;
            this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> <${ENTITY_PREFIX}${v}>.`);

        }
        return true;
    }

    visitComputeBooleanExpression(node : ThingTalk.Ast.ComputeBooleanExpression) : boolean {
        if (node.lhs instanceof Ast.Value.Computation) {
            if (node.lhs.op === 'count') {
                const property = (node.lhs.operands[0] as Ast.VarRefValue).name;
                const p = this._converter.getWikidataProperty(property);
                const op = ['>=', '<='].includes(node.operator) ? node.operator[0] : node.operator; // HACK
                const value = (node.rhs as Ast.NumberValue).value;
                const variable = this._converter.getEntityVariable();
                this._converter.addStatement(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${variable}.`);
                this._converter.addHaving(`COUNT(?${variable}) ${op} ${value}`);
                return true;
            }
        }
        throw new Error('Unsupported compute boolean expression: ' + node.prettyprint());
    }
}

interface Entity {
    value : string,
    name : string,
    canonical : string
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
        this._domainMap = {};
        if (options.human_readable_instance_of) {
            for (const entity of entities) {
                const qid = entity.name.match(/Q[0-9]+/g)![0];
                this._domainMap[entity.value] = qid;
            }
        }

        this._entityVariableCount = 0;
        this._statements = [];
        this._having = [];
        this._resultVariable = null;
        this._isBooleanQuestion = false;
        this._humanReadableInstanceOf = options.human_readable_instance_of;
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
        if (this._humanReadableInstanceOf) {
            if (domain in this._domainMap)
                return this._domainMap[domain];
            throw new Error('Unknown domain: ' + domain);
        }
        return domain;
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

    private _reset() {
        this._entityVariableCount = 0;
        this._statements = [];
        this._resultVariable = null;
        this._isBooleanQuestion = false;
    }

    private async _convertSingleTable(ast : Ast.Expression) {
        const tableInfoVisitor = new TableInfoVisitor(this);
        ast.visit(tableInfoVisitor);
        const subject = tableInfoVisitor.subject ?? '?' + this.getEntityVariable();
        if (subject.startsWith('?'))
            this.setResultVariable(subject);
        const projection = ast instanceof Ast.ProjectionExpression ? ast.args[0] : null;
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
        const sparql = (this._isBooleanQuestion ? `ASK ` : `SELECT DISTINCT ${this._resultVariable} `) + 
            `WHERE { ${this._statements.join((' '))} }`;
        if (this._having.length > 0)
            return sparql + ` GROUP BY ${this._resultVariable} HAVING(${this._having.join(' && ')})`;
        return sparql;
    }
}