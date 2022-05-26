import * as fs from 'fs';
import * as path from 'path';
import * as argparse from 'argparse';
import { Ast, Type } from 'thingtalk';
import { I18n, genBaseCanonical } from 'genie-toolkit';
import { Parser, SparqlParser, AskQuery, IriTerm, VariableTerm } from 'sparqljs';
import { extractProperties, extractTriples } from './utils/sparqljs';
import { Example, preprocessQALD } from './utils/qald';
import { cleanName, waitFinish } from './utils/misc';
import { idArgument, elemType } from './utils/thingtalk';
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
    experiment : 'qald7'|'qald9',
    cache : string,
    output : fs.WriteStream,
    include_non_entity_properties : boolean,
    use_wikidata_alt_labels : boolean
}

class ManifestGenerator {
    private _experiment : 'qald7'|'qald9';
    private _wikidata : WikidataUtils;
    private _parser : SparqlParser;
    private _tokenizer : I18n.BaseTokenizer;
    private _examples : Example[];
    private _entities : Record<string, Entity>;
    private _domainLabels : Record<string, string>; // Record<QID, domain label>
    private _domainSamples : Record<string, Record<string, string|null>>; // Record<QID, entities> 
    private _propertyLabelsByDomain : Record<string, Record<string, string>>; // Record<QID, Record<PID, property label>>
    /**
     * @member _properties: an object with PID as key, and argument definition as value, 
     * to record all properties in different functions, so we can add them 
     * to generic `entity` function all together. 
     */
    private _properties : Record<string, Ast.ArgumentDef>; // Record<PID, argument definition>
    /**
     * @member _propertyValues: an object to store parameter values, used for generating
     * parameter datasets. Since the paths of parameter datasets is based on the property name, 
     * we use that as the key instead of PID 
     */
    private _propertyValues : Record<string, Record<string, string>>; // Record<property name, Record<QID, value label>>
    /**
     * @member _propertyTypes : an object with PID as key, and thingtalk type as value
     */
    private _propertyTypes : Record<string, Type>;
    private _output : fs.WriteStream;

    private _includeNonEntityProperties : boolean;
    private _useWikidataAltLabels : boolean;

    constructor(options : ManifestGeneratorOptions) {
        this._experiment = options.experiment;
        this._wikidata = new WikidataUtils(options.cache);
        this._parser = new Parser();
        this._tokenizer = new I18n.LanguagePack('en-US').getTokenizer();
        this._examples = preprocessQALD(options.experiment);
        this._domainLabels = {};
        this._domainSamples = {};
        this._entities = {};
        this._propertyLabelsByDomain = {};
        this._properties = {};
        this._propertyValues = {};
        this._propertyTypes = {};
        this._output = options.output;

        this._includeNonEntityProperties = options.include_non_entity_properties;
        this._useWikidataAltLabels = options.use_wikidata_alt_labels;
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
     * Get the thingtalk type of a property
     * @param domain the QID of the domain
     * @param propertyId the PID of the property
     * @param propertyName the name of the property
     * @returns the ThingTalk type of the property
     */
    private async _getPropertyType(domain : string, propertyId : string, propertyName : string) {
        if (propertyId in this._propertyTypes) 
            return this._propertyTypes[propertyId];
        let type = await this._getPropertyTypeHelper(propertyId, propertyName);
        const qualifiers = await this._wikidata.getQualifiersByProperty(domain, propertyId);
        if (qualifiers.length > 0) {
            const fields : Record<string, Ast.ArgumentDef> = {
                value: new Ast.ArgumentDef(null, null, 'value', elemType(type))
            };
            for (const qualifier of qualifiers) {
                const name = this._wikidata.qualifiers[qualifier].name;
                const qtype = this._wikidata.qualifiers[qualifier].type;
                const annotation = { 
                    nl: { canonical: await this._generatePropertyCanonicals(qualifier, name, qtype) }, 
                    impl: { wikidata_id: new Ast.Value.String(qualifier) } 
                };
                fields[qualifier] = new Ast.ArgumentDef(null, null, name, qtype, annotation);
            }
            const compoundType = new Type.Compound(null, fields);
            type = type instanceof Type.Array ? new Type.Array(compoundType) : compoundType;
        }
        this._propertyTypes[propertyId] = type;
        return type;
    }

    private async _getPropertyTypeHelper(propertyId : string, propertyName : string) {
        if (propertyId === 'P21')
            return new Type.Enum(['female', 'male']);
        
        const timeProperties = await this._wikidata.getTimeProperties();
        if (timeProperties.includes(propertyId) || propertyName.startsWith('date_of_'))
            return Type.Date;
        
        const units = await this._wikidata.getAllowedUnits(propertyId);
        if (units.length > 0) {
            if (units.includes('kilogram'))
                return new Type.Measure('kg');
            if (units.includes('metre') ||  units.includes('kilometre'))
                return new Type.Measure('m');
            if (units.includes('second') || units.includes('year'))
                return new Type.Measure('ms');
            if (units.includes('degree Celsius'))
                return new Type.Measure('C');
            if (units.includes('metre per second') || units.includes('kilometre per second'))
                return new Type.Measure('mps');
            if (units.includes('square metre'))
                return new Type.Measure('m2');
            if (units.includes('cubic metre'))
                return new Type.Measure('m3');
            if (units.includes('percent'))
                return Type.Number;
            if (units.includes('United States dollar'))
                return Type.Currency;
            if (units.includes('human')) // capacity
                return Type.Number;
            throw new Error(`Unknown measurement type with unit ${units.join(', ')} for ${propertyId}`);
        }

        const range = await this._wikidata.getRangeConstraint(propertyId);
        if (range)
            return Type.Number;

        // default to an array entity type
        return new Type.Array(new Type.Entity(`org.wikidata:p_${propertyName}`));
    }

    /**
     * Get the canonicals for a given property
     * @param id QID of the property 
     * @param label Label of property 
     * @param type ThingTalk type of the property 
     */
    private async _generatePropertyCanonicals(id : string, label : string, type : Type) {
        const labels = [label];
        if (this._useWikidataAltLabels) {
            const altLabels = await this._wikidata.getAltLabels(id);
            labels.push(...altLabels);
        } 
        const baseCanonical = {};
        for (const label of labels) 
            genBaseCanonical(baseCanonical, label, type, null);
        return baseCanonical;
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
        try {
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
        } catch(e) {
            console.log(`Failed to convert sparql: ${example.sparql}`);
            console.error(e);
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
            const ptype = await this._getPropertyType(domain, property, pname);
            const argumentDef = new Ast.ArgumentDef(
                null,
                Ast.ArgDirection.OUT,
                pname, 
                ptype,
                { 
                    nl: { canonical: await this._generatePropertyCanonicals(property, label, ptype) }, 
                    impl: { wikidata_id: new Ast.Value.String(property) } 
                }
            );
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
                    this._propertyValues[pname][value] = valueLabels[value] ?? value;
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
        const samples = await this._wikidata.getEntitiesByDomain(domain); 
        const sampleLabels = await this._wikidata.getLabelsByBatch(...samples);
        this._domainSamples[fname] = sampleLabels;
        
        // get all properties by sampling Wikidata
        const args = await this._processDomainProperties(domain, fname);
        const missing = [];
        // add missing properties needed by QALD if necessary 
        for (const [id, label] of Object.entries(this._propertyLabelsByDomain[domain])) {
            const pname = cleanName(label);
            if (args.some((a) => a.name === pname) || id === 'P31')
                continue;
            missing.push([id, label]);
            const ptype = await this._getPropertyType(domain, id, pname);
            const argumentDef = new Ast.ArgumentDef(
                null, 
                Ast.ArgDirection.OUT, 
                pname,
                ptype,
                {
                    nl: { canonical:  await this._generatePropertyCanonicals(id, label, ptype) },
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
                inherit_arguments: new Ast.Value.Boolean(false),
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
        // imports
        const imports = [
            new Ast.MixinImportStmt(null, ['loader'], 'org.thingpedia.v2', []),
            new Ast.MixinImportStmt(null, ['config'], 'org.thingpedia.config.none', [])
        ];

        // queries
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

        // entity declarations
        const entities : Ast.EntityDef[] = Object.values(this._entities).map((entity) => {
            return new Ast.EntityDef(
                null,
                entity.type.slice('org.wikidata:'.length),
                (entity.subtype_of ?? []).map((e) => e.slice('org.wikidata:'.length)),
                { impl: { has_ner: new Ast.Value.Boolean(!!entity.has_ner_support) } }
            );
        });

        console.log('Start writing device manifest ...');
        const whitelist =  new Ast.Value.Array(
            Object.keys(queries).filter((qname) => qname !== 'entity').map((qname) => new Ast.Value.String(qname))
        );
        return new Ast.ClassDef(null, 'org.wikidata', null, {
            imports, queries, entities
        }, {
            nl: { name: `WikidataQA based on ${this._experiment}`, description: 'Question Answering over Wikidata' },
            impl: { whitelist }
        });
    }

    /**
     * Output the parameter datasets 
     */
    async _outputParameterDatasets() {
        const dir = path.dirname(this._output.path as string);
        const index = fs.createWriteStream(dir + '/parameter-datasets.tsv');
        for (const [fname, values] of Object.entries(this._domainSamples)) {
            index.write(`entity\ten-US\torg.wikidata:${fname}\tparameter-datasets/${fname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/${fname}.json`);
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
        for (const [pname, values] of Object.entries(this._propertyValues)) {
            index.write(`entity\ten-US\torg.wikidata:p_${pname}\tparameter-datasets/p_${pname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/p_${pname}.json`);
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
    parser.add_argument('--experiment', {
        required: false,
        default: 'qald7'
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--include-non-entity-properties', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--use-wikidata-alt-labels', {
        action: 'store_true',
        help: 'Enable wikidata alternative labels as annotations.',
        default: false
    });
    const args = parser.parse_args();

    const generator = new ManifestGenerator(args);
    generator.generate();
}

main();