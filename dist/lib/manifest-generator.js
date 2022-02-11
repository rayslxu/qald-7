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
const path = __importStar(require("path"));
const argparse = __importStar(require("argparse"));
const thingtalk_1 = require("thingtalk");
const genie_toolkit_1 = require("genie-toolkit");
const sparqljs_1 = require("sparqljs");
const sparqljs_2 = require("./utils/sparqljs");
const qald_1 = require("./utils/qald");
const misc_1 = require("./utils/misc");
const wikidata_1 = __importDefault(require("./utils/wikidata"));
const wikidata_2 = require("./utils/wikidata");
class ManifestGenerator {
    constructor(options) {
        this._wikidata = new wikidata_1.default(options.cache);
        this._parser = new sparqljs_1.Parser();
        this._tokenizer = new genie_toolkit_1.I18n.LanguagePack('en-US').getTokenizer();
        this._examples = (0, qald_1.preprocessQALD)();
        this._domainLabels = {};
        this._domainSamples = {};
        this._entities = {};
        this._propertyLabelsByDomain = {};
        this._properties = {};
        this._propertyValues = {};
        this._output = options.output;
        this._includeNonEntityProperties = options.include_non_entity_properties;
    }
    /**
     * Get the domain of a entity
     * @param entityId QID of an entity
     * @returns its domain, i.e., heuristically the best entity among values of P31 (instance of)
     */
    async _getEntityDomain(entityId) {
        return this._wikidata.getDomain(entityId);
    }
    /**
     * Add property to domain
     * @param entityId QID of a domain
     * @param propertyId PID of a property
     */
    async _updateProperties(entityId, propertyId) {
        if (!(entityId in this._propertyLabelsByDomain))
            this._propertyLabelsByDomain[entityId] = {};
        const propertyLabel = await this._wikidata.getLabel(propertyId);
        this._propertyLabelsByDomain[entityId][propertyId] = propertyLabel !== null && propertyLabel !== void 0 ? propertyLabel : propertyId;
    }
    /**
     * Add an entity to entities.json
     * @param type the entity type
     * @param name the name of the entity
     */
    _addEntity(type, name) {
        if (!(type in this._entities)) {
            this._entities[type] = {
                type: `org.wikidata:${type}`,
                name,
                is_well_known: false,
                has_ner_support: true,
                subtype_of: type === 'entity' ? null : ['org.wikidata:entity']
            };
        }
    }
    /**
     * Process one example in QALD
     * (1) get all subject, and add their domain into domain list
     * (2) make sure all properties used are covered for the domain
     * @param example an cleaned QALD example
     */
    async _processOneExample(example) {
        var _a;
        const parsed = this._parser.parse(example.sparql);
        const triples = (0, sparqljs_2.extractTriples)(parsed);
        const variables = {};
        // if variable appears as a subject of a statement, where to predicate is P31
        // add the object of this statement into the domain list
        for (const triple of triples) {
            if (triple.predicate.value === `${wikidata_2.PROPERTY_PREFIX}P31` &&
                triple.subject.termType === 'Variable' &&
                triple.object.termType === 'NamedNode') {
                const domain = triple.object.value.slice(wikidata_2.ENTITY_PREFIX.length);
                variables[triple.subject.value] = domain;
                this._domainLabels[domain] = (_a = await this._wikidata.getLabel(domain)) !== null && _a !== void 0 ? _a : domain;
            }
        }
        for (const triple of triples) {
            if (triple.subject.termType === 'NamedNode') {
                const entityId = triple.subject.value.slice(wikidata_2.ENTITY_PREFIX.length);
                const domain = await this._getEntityDomain(entityId);
                if (!domain)
                    continue;
                const domainLabel = await this._wikidata.getLabel(domain);
                this._domainLabels[domain] = domainLabel || domain;
                for (const property of (0, sparqljs_2.extractProperties)(triple.predicate))
                    await this._updateProperties(domain, property);
            }
            else if (triple.subject.termType === 'Variable' && triple.subject.value in variables) {
                const domain = variables[triple.subject.value];
                for (const property of (0, sparqljs_2.extractProperties)(triple.predicate))
                    await this._updateProperties(domain, property);
            }
        }
    }
    /**
     * Process all examples in QALD
     */
    async _processExamples() {
        for (const example of this._examples)
            await this._processOneExample(example);
    }
    /**
     * Query Wikidata to obtain common properties of a domain
     * @param domain QID of a domain
     * @param entityType snake cased label of the domain
     */
    async _processDomainProperties(domain, entityType) {
        var _a, _b;
        const args = [(0, misc_1.idArgument)((0, misc_1.cleanName)(entityType))];
        const propertyValues = await this._wikidata.getDomainPropertiesAndValues(domain, this._includeNonEntityProperties);
        const propertyLabels = await this._wikidata.getLabelsByBatch(...Object.keys(propertyValues));
        const valueLabels = await this._wikidata.getLabelsByBatch(...Object.values(propertyValues).flat());
        for (const property in propertyValues) {
            const label = (_a = propertyLabels[property]) !== null && _a !== void 0 ? _a : property;
            const pname = (0, misc_1.cleanName)(label);
            const argumentDef = new thingtalk_1.Ast.ArgumentDef(null, thingtalk_1.Ast.ArgDirection.OUT, pname, new thingtalk_1.Type.Array(new thingtalk_1.Type.Entity(`org.wikidata:p_${pname}`)), {
                nl: { canonical: { base: [label] } },
                impl: { wikidata_id: new thingtalk_1.Ast.Value.String(property) }
            });
            args.push(argumentDef);
            this._addEntity(`p_${pname}`, label);
            if (!(property in this._properties))
                this._properties[property] = argumentDef;
            const values = propertyValues[property];
            // TODO: separate property values by domain
            if (values.length > 0) {
                if (!(pname in this._propertyValues))
                    this._propertyValues[pname] = {};
                for (const value of values) {
                    if (value in this._propertyValues[pname])
                        continue;
                    this._propertyValues[pname][value] = (_b = valueLabels[value]) !== null && _b !== void 0 ? _b : value;
                }
            }
        }
        return args;
    }
    /**
     * Get a thingtalk query for a domain
     * @param domain QID of a domain
     * @returns A function definition of this domain
     */
    async _processDomain(domain) {
        const domainLabel = this._domainLabels[domain];
        console.log(`Sampling ${domainLabel} domain ...`);
        const fname = (0, misc_1.cleanName)(domainLabel);
        this._addEntity(fname, domainLabel);
        const samples = await this._wikidata.getEntitiesByDomain(domain);
        const sampleLabels = await this._wikidata.getLabelsByBatch(...samples);
        this._domainSamples[fname] = sampleLabels;
        // get all properties by sampling Wikidata
        const args = await this._processDomainProperties(domain, fname);
        const missing = [];
        // add missing properties needed by QALD if necessary 
        for (const [id, label] of Object.entries(this._propertyLabelsByDomain[domain])) {
            const pname = (0, misc_1.cleanName)(label);
            if (args.some((a) => a.name === pname) || id === 'P31')
                continue;
            missing.push([id, label]);
            const ptype = new thingtalk_1.Type.Array(new thingtalk_1.Type.Entity(`org.wikidata:p_${pname}`));
            const baseCanonical = {};
            (0, genie_toolkit_1.genBaseCanonical)(baseCanonical, pname, ptype, null);
            const argumentDef = new thingtalk_1.Ast.ArgumentDef(null, thingtalk_1.Ast.ArgDirection.OUT, pname, ptype, {
                nl: { canonical: baseCanonical },
                impl: { wikidata_id: new thingtalk_1.Ast.Value.String(id) }
            });
            args.push(argumentDef);
            this._addEntity(`p_${pname}`, label);
            this._properties[label] = argumentDef;
        }
        console.log(`Done sampling ${domainLabel} domain`);
        console.log(`In total ${args.length} properties sampled, ${missing.length} not covered`);
        if (missing.length > 0)
            console.log(missing.map(([id, label]) => `${label} (${id})`).join(', '));
        const functionDef = new thingtalk_1.Ast.FunctionDef(null, 'query', null, fname, ['entity'], {
            is_list: true,
            is_monitorable: false
        }, args, {
            nl: { canonical: [domainLabel] },
            impl: {
                inherit_arguments: new thingtalk_1.Ast.Value.Boolean(false),
                handle_thingtalk: new thingtalk_1.Ast.Value.Boolean(true),
                wikidata_subject: new thingtalk_1.Ast.Value.Array([new thingtalk_1.Ast.Value.String(domain)])
            }
        });
        return [fname, functionDef];
    }
    /**
     * Generate the manifest
     * @returns the class definition
     */
    async _generateManifest() {
        const imports = [
            new thingtalk_1.Ast.MixinImportStmt(null, ['loader'], 'org.thingpedia.v2', []),
            new thingtalk_1.Ast.MixinImportStmt(null, ['config'], 'org.thingpedia.config.none', [])
        ];
        const queries = {};
        for (const domain in this._propertyLabelsByDomain) {
            const [fname, functionDef] = await this._processDomain(domain);
            queries[fname] = functionDef;
        }
        queries['entity'] = new thingtalk_1.Ast.FunctionDef(null, 'query', null, 'entity', [], {
            is_list: true,
            is_monitorable: false
        }, [(0, misc_1.idArgument)('entity'), ...Object.values(this._properties)], {
            impl: {
                handle_thingtalk: new thingtalk_1.Ast.Value.Boolean(true),
                wikidata_subject: new thingtalk_1.Ast.Value.Array([new thingtalk_1.Ast.Value.String('Q35120')])
            }
        });
        this._addEntity('entity', 'Entity');
        console.log('Start writing device manifest ...');
        const whitelist = new thingtalk_1.Ast.Value.Array(Object.keys(queries).filter((qname) => qname !== 'entity').map((qname) => new thingtalk_1.Ast.Value.String(qname)));
        return new thingtalk_1.Ast.ClassDef(null, 'org.wikidata', null, {
            imports, queries
        }, {
            nl: { name: 'WikidataQA', description: 'Question Answering over Wikidata' },
            impl: { whitelist }
        });
    }
    /**
     * Output the parameter datasets
     */
    async _outputParameterDatasets() {
        const dir = path.dirname(this._output.path);
        const index = fs.createWriteStream(dir + '/parameter-datasets.tsv');
        for (const [fname, values] of Object.entries(this._domainSamples)) {
            index.write(`entity\ten-US\torg.wikidata:${fname}\tparameter-datasets/${fname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/${fname}.json`);
            const data = { result: "ok", data: [] };
            for (const [value, display] of Object.entries(values)) {
                if (display) {
                    const canonical = this._tokenizer.tokenize(display).rawTokens.join(' ');
                    data.data.push({ value: value, name: display, canonical });
                }
            }
            paramDataset.end(JSON.stringify(data, undefined, 2));
            await (0, misc_1.waitFinish)(paramDataset);
        }
        for (const [pname, values] of Object.entries(this._propertyValues)) {
            index.write(`entity\ten-US\torg.wikidata:p_${pname}\tparameter-datasets/p_${pname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/p_${pname}.json`);
            const data = { result: "ok", data: [] };
            for (const [value, display] of Object.entries(values)) {
                if (display) {
                    const canonical = this._tokenizer.tokenize(display).rawTokens.join(' ');
                    data.data.push({ value: value, name: display, canonical });
                }
            }
            paramDataset.end(JSON.stringify(data, undefined, 2));
            await (0, misc_1.waitFinish)(paramDataset);
        }
        index.end();
        await (0, misc_1.waitFinish)(index);
    }
    /**
     * Output entities.json
     */
    async _outputEntities() {
        const dir = path.dirname(this._output.path);
        const output = fs.createWriteStream(dir + '/entities.json');
        const data = { result: "ok", data: Object.values(this._entities) };
        output.end(JSON.stringify(data, undefined, 2));
        await (0, misc_1.waitFinish)(output);
    }
    /**
     * Process all examples in QALD and then generate/output the manifest and parameter datasets
     */
    async generate() {
        console.log('Start processing QALD examples ...');
        await this._processExamples();
        console.log(`Done processing QALD examples, ${Object.keys(this._domainLabels).length} domains discovered: `);
        for (const [domain, domainLabel] of Object.entries(this._domainLabels))
            console.log(`${domain}: ${domainLabel}`);
        console.log('Start sampling Wikidata for schema ...');
        const classDef = await this._generateManifest();
        this._output.end(classDef.prettyprint());
        await (0, misc_1.waitFinish)(this._output);
        console.log('Start generating parameter datasets ...');
        await this._outputEntities();
        await this._outputParameterDatasets();
        console.log('Done.');
    }
}
async function main() {
    const parser = new argparse.ArgumentParser({
        add_help: true,
        description: "Generate a schema and parameter dataset from QALD-7"
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--include-non-entity-properties', {
        required: false,
        default: false,
        type: Boolean
    });
    const args = parser.parse_args();
    const generator = new ManifestGenerator(args);
    generator.generate();
}
main();
//# sourceMappingURL=manifest-generator.js.map