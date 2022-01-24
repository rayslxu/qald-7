import * as fs from 'fs';
import * as path from 'path';
import * as argparse from 'argparse';
import { Ast, Type } from 'thingtalk';
import { I18n, genBaseCanonical } from 'genie-toolkit';
import { Parser, SparqlParser, AskQuery, IriTerm, VariableTerm } from 'sparqljs';
import { extractProperties, extractTriples } from './utils/sparqljs';
import { Example, preprocessQALD } from './utils/qald';
import { cleanName, waitFinish, idArgument } from './utils/misc';
import WikidataUtils from './utils/wikidata';
import { PROPERTY_PREFIX, ENTITY_PREFIX } from './utils/wikidata';

interface Entity {
    type : string;
    name : string;
    is_well_known : boolean;
    has_ner_support : boolean;
    subtype_of : string[]|null;
}

interface ManifestGeneratorOptions {
    cache : string,
    output : fs.WriteStream,
    include_non_entity_properties : boolean
}

class ManifestGenerator {
    private _wikidata : WikidataUtils;
    private _parser : SparqlParser;
    private _tokenizer : I18n.BaseTokenizer;
    private _examples : Example[];
    private _entities : Record<string, Entity>;
    private _domainLabels : Record<string, string>; // Record<domain, domain label>
    private _propertyLabelsByDomain : Record<string, Record<string, string>>; // Record<domain, Record<PID, property label>
    private _properties : Record<string, Ast.ArgumentDef>;
    private _propertyValues : Record<string, Record<string, string>>;
    private _output : fs.WriteStream;

    private _includeNonEntityProperties : boolean;

    constructor(options : ManifestGeneratorOptions) {
        this._wikidata = new WikidataUtils(options.cache);
        this._parser = new Parser();
        this._tokenizer = new I18n.LanguagePack('en-US').getTokenizer();
        this._examples = preprocessQALD();
        this._domainLabels = {};
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
    private async _getEntityDomain(entityId : string) {
        return this._wikidata.getDomain(entityId);
    }

    /**
     * Add property to domain
     * @param entityId QID of a domain
     * @param propertyId PID of a property 
     */
    private async _updateProperties(entityId : string, propertyId : string) {
        if (!(entityId in this._propertyLabelsByDomain)) 
            this._propertyLabelsByDomain[entityId] = {};
        
        const propertyLabel = await this._wikidata.getLabel(propertyId);
        this._propertyLabelsByDomain[entityId][propertyId] = propertyLabel ?? propertyId;
    }

    /**
     * Add an entity to entities.json
     * @param type the entity type 
     * @param name the name of the entity
     */
    private _addEntity(type : string, name : string) {
        if (!(type in this._entities)) {
            this._entities[type] = {
                type: `org.wikidata:${type}`,
                name, 
                is_well_known: false,
                has_ner_support: true,
                subtype_of : type === 'entity' ? null : ['org.wikidata:entity']
            };
        }
    }

    /**
     * Process one example in QALD
     * (1) get all subject, and add their domain into domain list 
     * (2) make sure all properties used are covered for the domain
     * @param example an cleaned QALD example
     */
    private async _processOneExample(example : Example) {
        const parsed = this._parser.parse(example.sparql) as AskQuery;
        const triples = extractTriples(parsed);

        const variables : Record<string, string> = {};
        // if variable appears as a subject of a statement, where to predicate is P31
        // add the object of this statement into the domain list
        for (const triple of triples) {
            if ((triple.predicate as IriTerm).value === `${PROPERTY_PREFIX}P31` && 
                (triple.subject as VariableTerm).termType === 'Variable' &&
                (triple.object as IriTerm).termType === 'NamedNode') {
                const domain = triple.object.value.slice(ENTITY_PREFIX.length);
                variables[triple.subject.value] = domain;
                this._domainLabels[domain] = await this._wikidata.getLabel(domain) ?? domain;
            }
        }
        for (const triple of triples) {
            if ((triple.subject as IriTerm).termType === 'NamedNode') {
                const entityId = triple.subject.value.slice(ENTITY_PREFIX.length);
                const domain = await this._getEntityDomain(entityId);
                if (!domain)
                    continue;
                const domainLabel = await this._wikidata.getLabel(domain);
                this._domainLabels[domain] = domainLabel || domain;
                for (const property of extractProperties(triple.predicate)) 
                    await this._updateProperties(domain, property);
            } else if ((triple.subject as VariableTerm).termType === 'Variable' && triple.subject.value in variables) {
                const domain = variables[triple.subject.value];
                for (const property of extractProperties(triple.predicate))
                    await this._updateProperties(domain, property);
            }
        }
    }

    /**
     * Process all examples in QALD
     */
    private async _processExamples() {
        for (const example of this._examples) 
            await this._processOneExample(example);
    }


    /**
     * Query Wikidata to obtain common properties of a domain
     * @param domain QID of a domain
     * @param entityType snake cased label of the domain
     */
    private async _processDomainProperties(domain : string, entityType : string) {
        const args = [idArgument(cleanName(entityType))];
        const propertyValues = await this._wikidata.getDomainPropertiesAndValues(domain, this._includeNonEntityProperties);
        const propertyLabels = await this._wikidata.getLabelsByBatch(...Object.keys(propertyValues));
        const valueLabels = await this._wikidata.getLabelsByBatch(...Object.values(propertyValues).flat());
        for (const property in propertyValues) {
            const label = propertyLabels[property] ?? property;
            const pname = cleanName(label);
            const argumentDef = new Ast.ArgumentDef(
                null,
                Ast.ArgDirection.OUT,
                pname, 
                new Type.Array(new Type.Entity(`org.wikidata:p_${pname}`)),
                { 
                    nl: { canonical: { base: [label] } },
                    impl: { wikidata_id: new Ast.Value.String(property) } 
                }
            );
            args.push(argumentDef);
            this._addEntity(`p_${pname}`, label);
            if (!(label in this._properties))
                this._properties[label] = argumentDef;
            const values = propertyValues[property];
            // TODO: separate property values by domain
            if (values.length > 0) {
                if (!(label in this._propertyValues))
                    this._propertyValues[label] = {};
                for (const value of values) {
                    if (value in this._propertyValues[label])
                        continue;
                    this._propertyValues[label][value] = valueLabels[value] ?? value;
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
    private async _processDomain(domain : string) : Promise<[string, Ast.FunctionDef]> {
        const domainLabel = this._domainLabels[domain];
        console.log(`Sampling ${domainLabel} domain ...`);
        const fname = cleanName(domainLabel);
        this._addEntity(fname, domainLabel);
        // get all properties by sampling Wikidata
        const args = await this._processDomainProperties(domain, fname);
        const missing = [];
        // add missing properties needed by QALD if necessary 
        for (const [id, label] of Object.entries(this._propertyLabelsByDomain[domain])) {
            const pname = cleanName(label);
            if (args.some((a) => a.name === pname) || id === 'P31')
                continue;
            missing.push([id, label]);
            const ptype = new Type.Array(new Type.Entity(`org.wikidata:p_${pname}`));
            const baseCanonical = {};
            genBaseCanonical(baseCanonical, pname, ptype, null);
            const argumentDef = new Ast.ArgumentDef(
                null, 
                Ast.ArgDirection.OUT, 
                pname,
                ptype,
                {
                    nl: { canonical:  baseCanonical },
                    impl: { wikidata_id: new Ast.Value.String(id) }
                }
            );
            args.push(argumentDef);
            this._addEntity(`p_${pname}`, label);
            this._properties[label] = argumentDef;
        }
        console.log(`Done sampling ${domainLabel} domain`);
        console.log(`In total ${args.length} properties sampled, ${missing.length} not covered`);
        if (missing.length > 0)
            console.log(missing.map(([id, label]) => `${label} (${id})`).join(', '));

        const functionDef = new Ast.FunctionDef(null, 'query', null, fname, ['entity'], {
            is_list: true, 
            is_monitorable: false
        }, args, {
            nl: { canonical: [domainLabel] },
            impl : {
                handle_thingtalk: new Ast.Value.Boolean(true),
                wikidata_subject: new Ast.Value.Array([new Ast.Value.String(domain)])
            }
        });
        return [fname, functionDef];
    }

    /**
     * Generate the manifest 
     * @returns the class definition 
     */
    async _generateManifest() : Promise<Ast.ClassDef> {
        const imports = [
            new Ast.MixinImportStmt(null, ['loader'], 'org.thingpedia.v2', []),
            new Ast.MixinImportStmt(null, ['config'], 'org.thingpedia.config.none', [])
        ];
        const queries : Record<string, Ast.FunctionDef> = {};
        for (const domain in this._propertyLabelsByDomain) {
            const [fname, functionDef] = await this._processDomain(domain);
            queries[fname] = functionDef;
        }
        queries['entity'] = new Ast.FunctionDef(null, 'query', null, 'entity',[], {
            is_list: true,
            is_monitorable: false
        }, [idArgument('entity'), ...Object.values(this._properties)], {
            impl : {
                handle_thingtalk: new Ast.Value.Boolean(true),
                wikidata_subject: new Ast.Value.Array([new Ast.Value.String('Q35120')])
            }
        });
        this._addEntity('entity', 'Entity');

        console.log('Start writing device manifest ...');
        const whitelist =  new Ast.Value.Array(
            Object.keys(queries).filter((qname) => qname !== 'entity').map((qname) => new Ast.Value.String(qname))
        );
        return new Ast.ClassDef(null, 'org.wikidata', null, {
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
        const dir = path.dirname(this._output.path as string);
        const index = fs.createWriteStream(dir + '/parameter-datasets.tsv');
        for (const [property, values] of Object.entries(this._propertyValues)) {
            const pname = cleanName(property);
            index.write(`entity\ten-US\torg.wikdiata:${pname}\tparameter-datasets/${pname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/${pname}.json`);
            const data : Record<string, any> = { result: "ok", data: [] };
            for (const [value, display] of Object.entries(values)) {
                if (display) {
                    const canonical = this._tokenizer.tokenize(display).rawTokens.join(' ');
                    data.data.push({ value : value, name: display, canonical });
                }
            }
            paramDataset.end(JSON.stringify(data, undefined, 2));
            await waitFinish(paramDataset);
        }
        index.end();
        await waitFinish(index);
    }

    /**
     * Output entities.json
     */
    async _outputEntities() {
        const dir = path.dirname(this._output.path as string);
        const output = fs.createWriteStream(dir + '/entities.json');
        const data = { result: "ok", data: Object.values(this._entities) };
        output.end(JSON.stringify(data, undefined, 2));
        await waitFinish(output);
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
        await waitFinish(this._output);

        console.log('Start generating parameter datasets ...');
        await this._outputEntities();
        await this._outputParameterDatasets();
        console.log('Done.');
        
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Generate a schema and parameter dataset from QALD-7"
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