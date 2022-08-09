"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const genie_toolkit_1 = require("genie-toolkit");
const thingtalk_1 = require("thingtalk");
const wikidata_1 = __importDefault(require("../utils/wikidata"));
const wikidata_2 = require("../utils/wikidata");
const ENTITY_VARIABLES = ['x', 'y', 'z'];
// const PREDICATE_VARIABLES = ['p', 'q', 'r'];
class TableInfoVisitor extends thingtalk_1.Ast.NodeVisitor {
    visitChainExpression(node) {
        if (node.expressions.length > 1)
            throw new Error(`Not supported: chain expression`);
        return true;
    }
    visitAtomBooleanExpression(node) {
        if (node.name === 'id' && node.value instanceof thingtalk_1.Ast.EntityValue)
            this.subject = 'wd:' + node.value.value;
        if (node.name === 'instance_of' && node.value instanceof thingtalk_1.Ast.EntityValue)
            this.domainName = node.value.value;
        return true;
    }
}
class TripleGenerator extends thingtalk_1.Ast.NodeVisitor {
    constructor(converter, subject, domain) {
        super();
        this._converter = converter;
        this._subject = subject;
        this._triples = [];
        if (domain)
            this._triples.push(`${subject} <${wikidata_2.PROPERTY_PREFIX}P31> <${wikidata_2.ENTITY_PREFIX}${domain}>.`);
    }
    get triples() {
        return this._triples;
    }
    visitProjectionExpression(node) {
        for (const arg of node.args) {
            const p = this._converter.getWikidataProperty(arg);
            const v = this._converter.getEntityVariable();
            this._triples.push(`${this._subject} <${wikidata_2.PROPERTY_PREFIX}${p}> ?${v}.`);
        }
        return true;
    }
    visitProjectionExpression2(node) {
        var _a;
        for (const proj of node.projections) {
            if (proj.value instanceof thingtalk_1.Ast.Value)
                throw new Error('Not supported: value in projection');
            if (Array.isArray(proj.value)) {
                const path = [];
                for (const element of proj.value) {
                    const property = this._converter.getWikidataProperty(element.property);
                    path.push(`<${wikidata_2.PROPERTY_PREFIX}${property}>${(_a = element.quantifier) !== null && _a !== void 0 ? _a : ''}`);
                }
                const v = this._converter.getEntityVariable();
                this._triples.push(`${this._subject} ${path.join('/')}, ?${v}.`);
            }
            else {
                const p = this._converter.getWikidataProperty(proj.value);
                const v = this._converter.getEntityVariable();
                this._triples.push(`${this._subject} <${wikidata_2.PROPERTY_PREFIX}${p}> ?${v}.`);
            }
        }
        return true;
    }
    visitAtomBooleanExpression(node) {
        if (node.name !== 'id' && node.name !== 'instance_of') {
            const property = node.name;
            const p = this._converter.getWikidataProperty(property);
            const domain = node.value.value;
            const q = this._converter.getWikidataDomain(domain);
            this._triples.push(`${this._subject} <${wikidata_2.PROPERTY_PREFIX}${p}> <${wikidata_2.ENTITY_PREFIX}${q}>.`);
        }
        return true;
    }
}
class ThingTalkToSPARQLConverter {
    constructor(classDef, entities, options) {
        this._classDef = classDef;
        this._locale = options.locale;
        this._timezone = options.timezone;
        this._kb = new wikidata_1.default(options.cache, options.bootleg);
        this._propertyMap = { "P31": "instance_of" };
        for (const property of this._classDef.queries['entity'].iterateArguments()) {
            const qid = property.getImplementationAnnotation('wikidata_id');
            this._propertyMap[property.name] = qid;
        }
        this._domainMap = {};
        for (const entity of entities) {
            const qid = entity.name.match(/Q[0-9]+/g)[0];
            this._domainMap[entity.value] = qid;
        }
        this._entityVariableCount = 0;
        this._statements = [];
    }
    getEntityVariable() {
        return ENTITY_VARIABLES[this._entityVariableCount++];
    }
    getWikidataProperty(property) {
        return this._propertyMap[property];
    }
    async getWikidataDomain(domain) {
        if (domain in this._domainMap)
            return this._domainMap[domain];
        return this._kb.getEntityByName(domain);
    }
    async _convertSingleTable(ast) {
        var _a;
        const tableInfoVisitor = new TableInfoVisitor();
        ast.visit(tableInfoVisitor);
        const subject = (_a = tableInfoVisitor.subject) !== null && _a !== void 0 ? _a : '?' + this.getEntityVariable();
        const domain = tableInfoVisitor.domainName ? await this.getWikidataDomain(tableInfoVisitor.domainName) : null;
        const tripleGenerator = new TripleGenerator(this, subject, domain);
        ast.visit(tripleGenerator);
        this._statements.push(...tripleGenerator.triples);
    }
    async convert(utterance, thingtalk) {
        const entities = genie_toolkit_1.EntityUtils.makeDummyEntities(utterance);
        const ast = thingtalk_1.Syntax.parse(thingtalk, thingtalk_1.Syntax.SyntaxType.Tokenized, entities, {
            locale: this._locale, timezone: this._timezone
        });
        await this._convertSingleTable(ast);
        return `SELECT DISTINCT ?x WHERE { ${this._statements.join(('. '))} }`;
    }
}
exports.default = ThingTalkToSPARQLConverter;
//# sourceMappingURL=thingtalk2sparql.js.map