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
            this.subject = 'wd:' + node.value.value!;
        if (node.name === 'instance_of' && node.value instanceof Ast.EntityValue)
            this.domainName = node.value.value!;
        return true;
    }
}

class TripleGenerator extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    private _subject : string;
    private _triples : string[];

    constructor(converter : ThingTalkToSPARQLConverter, subject : string, domain : string|null) {
        super();
        this._converter = converter;
        this._subject = subject;
        this._triples = [];
        if (domain)
            this._triples.push(`${subject} <${PROPERTY_PREFIX}P31> <${ENTITY_PREFIX}${domain}>.`);
    }

    get triples() {
        return this._triples;
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        for (const arg of node.args) {
            const p = this._converter.getWikidataProperty(arg);
            const v = this._converter.getEntityVariable();
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
            const domain = (node.value as Ast.EntityValue).value!;
            const q = this._converter.getWikidataDomain(domain);
            this._triples.push(`${this._subject} <${PROPERTY_PREFIX}${p}> <${ENTITY_PREFIX}${q}>.`);

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
    bootleg : string
}
export default class ThingTalkToSPARQLConverter {
    private _classDef : Ast.ClassDef;
    private _locale : string;
    private _timezone ?: string;
    private _kb : WikidataUtils;
    private _propertyMap : Record<string, string>;
    private _domainMap : Record<string, string>;

    private _entityVariableCount : number;
    private _statements : string[];

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
        for (const entity of entities) {
            const qid = entity.name.match(/Q[0-9]+/g)![0];
            this._domainMap[entity.value] = qid;
        }

        this._entityVariableCount = 0;
        this._statements = [];
    }

    getEntityVariable() : string {
        return ENTITY_VARIABLES[this._entityVariableCount ++];
    }

    getWikidataProperty(property : string) : string {
        return this._propertyMap[property];
    }

    async getWikidataDomain(domain : string) : Promise<string|null> {
        if (domain in this._domainMap)
            return this._domainMap[domain];
        return this._kb.getEntityByName(domain);
    }

    private async _convertSingleTable(ast : Ast.Node) {
        const tableInfoVisitor = new TableInfoVisitor();
        ast.visit(tableInfoVisitor);
        const subject = tableInfoVisitor.subject ?? '?' + this.getEntityVariable();
        const domain = tableInfoVisitor.domainName ? await this.getWikidataDomain(tableInfoVisitor.domainName) : null;
        const tripleGenerator = new TripleGenerator(this, subject, domain);
        ast.visit(tripleGenerator);
        this._statements.push(...tripleGenerator.triples);

    }

    async convert(utterance : string, thingtalk : string) : Promise<string> {
        const entities = EntityUtils.makeDummyEntities(utterance);
        const ast = Syntax.parse(thingtalk, Syntax.SyntaxType.Tokenized, entities, {
            locale : this._locale, timezone: this._timezone
        });
        await this._convertSingleTable(ast);        
        return `SELECT DISTINCT ?x WHERE { ${this._statements.join(('. '))} }`;
    }
}