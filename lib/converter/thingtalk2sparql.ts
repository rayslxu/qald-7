import assert from 'assert';
import { EntityUtils } from 'genie-toolkit';
import ThingTalk from 'thingtalk';
import { Ast, Syntax } from "thingtalk";
import WikidataUtils from '../utils/wikidata';
import { ENTITY_PREFIX, PROPERTY_PREFIX } from '../utils/wikidata';

const ENTITY_VARIABLES = ['x', 'y', 'z'];
// const PREDICATE_VARIABLES = ['p', 'q', 'r'];

class TableInfoVisitor extends Ast.NodeVisitor {
    subject ?: string;
    domainName ?: string;

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
}

class TripleGenerator extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    private _subject : string;
    private _target_projection : string|null;
    private _target_projection_variable : string|null;
    private _triples : string[];

    constructor(converter : ThingTalkToSPARQLConverter, subject : string, projection : string|null, domain : string|null) {
        super();
        this._converter = converter;
        this._subject = subject;
        this._target_projection = projection;
        this._target_projection_variable = null;
        this._triples = [];
        if (domain)
            this._triples.push(`${subject} <${PROPERTY_PREFIX}P31> <${ENTITY_PREFIX}${domain}>.`);
    }

    get triples() {
        return this._triples;
    }

    get resultVariable() {
        return this._target_projection_variable ?? this._subject;
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        for (const arg of node.args) {
            const p = this._converter.getWikidataProperty(arg);
            const v = this._converter.getEntityVariable();
            if (arg === this._target_projection) 
                this._target_projection_variable = `?${v}`;
            this._triples.push(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${v}.`);
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
                this._triples.push(`${this._subject} ${path.join('/')}, ?${v}.`);
            } else {
                const p = this._converter.getWikidataProperty(proj.value);
                const v = this._converter.getEntityVariable();
                this._triples.push(`${this._subject} <${PROPERTY_PREFIX}${p}> ?${v}.`);
            }     
        }
        return true;
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        if (node.name !== 'id' && node.name !== 'instance_of') {
            const property = node.name;
            const p = this._converter.getWikidataProperty(property);
            const v = (node.value as Ast.EntityValue).value!;
            this._triples.push(`${this._subject} <${PROPERTY_PREFIX}${p}> <${ENTITY_PREFIX}${v}>.`);

        }
        return true;
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
    private _statements : string[];
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
        this._resultVariable = null;
        this._humanReadableInstanceOf = options.human_readable_instance_of;
    }

    get kb() {
        return this._kb;
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

    private _reset() {
        this._entityVariableCount = 0;
        this._statements = [];
        this._resultVariable = null;
    }

    private async _convertSingleTable(ast : Ast.Expression) {
        const tableInfoVisitor = new TableInfoVisitor();
        ast.visit(tableInfoVisitor);
        const subject = tableInfoVisitor.subject ?? '?' + this.getEntityVariable();
        const projection = ast instanceof Ast.ProjectionExpression ? ast.args[0] : null;
        const domain = tableInfoVisitor.domainName ? await this.getWikidataDomain(tableInfoVisitor.domainName) : null;
        const tripleGenerator = new TripleGenerator(this, subject, projection, domain);
        ast.visit(tripleGenerator);
        this._statements.push(...tripleGenerator.triples);
        this._resultVariable = tripleGenerator.resultVariable;
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
        return `SELECT DISTINCT ${this._resultVariable} WHERE { ${this._statements.join((' '))} }`;
    }
}