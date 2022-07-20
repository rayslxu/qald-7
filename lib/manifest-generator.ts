import * as fs from 'fs';
import * as path from 'path';
import * as argparse from 'argparse';
import csvstringify from 'csv-stringify';
import { Ast, Type } from 'thingtalk';
import { I18n, genBaseCanonical } from 'genie-toolkit';
import { Parser, SparqlParser, AskQuery, IriTerm, VariableTerm } from 'sparqljs';
import { extractProperties, extractTriples } from './utils/sparqljs';
import { Example, preprocessQALD } from './utils/qald';
import { cleanName, waitFinish } from './utils/misc';
import { idArgument, elemType } from './utils/thingtalk';
import WikidataUtils, { PROPERTY_QUALIFIER_PREFIX } from './utils/wikidata';
import { PROPERTY_PREFIX, ENTITY_PREFIX } from './utils/wikidata';

interface Entity {
    type : string;
    name : string;
    is_well_known : boolean;
    has_ner_support : boolean;
    subtype_of : string[]|null;
}

interface PropertyValues {
    entities : Record<string, Record<string, string>>, // Record<property name, Record<QID, value label>>
    strings : Record<string, string[]> // Record<property name, values>
}

interface ManifestGeneratorOptions {
    experiment : 'qald7'|'qald9',
    type_system : 'flat' | 'hierarchical'
    cache : string,
    output : fs.WriteStream,
    exclude_non_entity_properties : boolean,
    use_wikidata_alt_labels : boolean,
    bootleg_db : string
}

class ManifestGenerator {
    private _experiment : 'qald7'|'qald9';
    private _typeSystem : 'flat' | 'hierarchical';
    private _wikidata : WikidataUtils;
    private _parser : SparqlParser;
    private _tokenizer : I18n.BaseTokenizer;
    private _examples : Example[];
    private _entities : Record<string, Entity>;
    private _domainLabels : Record<string, string>; // Record<QID, domain label>
    private _subdomains : Record<string, string[]>; // subdomains for each domain
    private _domainSamples : Record<string, Record<string, string|null>>; // Record<QID, entities> 
    private _propertiesByDomainInQald : Record<string, Set<string>>; // Record<QID, Set<PID>>, domain and properties in QALD examples
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
    private _propertyValues : PropertyValues;
    /**
     * @member _propertyTypes : an object with PID as key, and thingtalk type as value
     */
    private _propertyTypes : Record<string, Type|null>;
    private _output : fs.WriteStream;

    private _includeNonEntityProperties : boolean;
    private _useWikidataAltLabels : boolean;

    constructor(options : ManifestGeneratorOptions) {
        this._experiment = options.experiment;
        this._typeSystem = options.type_system;
        this._wikidata = new WikidataUtils(options.cache, options.bootleg_db);
        this._parser = new Parser();
        this._tokenizer = new I18n.LanguagePack('en-US').getTokenizer();
        this._examples = preprocessQALD(options.experiment);
        this._domainLabels = {};
        this._subdomains = {};
        this._domainSamples = {};
        this._entities = {};
        this._propertiesByDomainInQald = {};
        this._properties = {};
        this._propertyValues = { entities: {}, strings: {} };
        this._propertyTypes = {};
        this._output = options.output;

        this._includeNonEntityProperties = !options.exclude_non_entity_properties;
        this._useWikidataAltLabels = options.use_wikidata_alt_labels;
    }

    /**
     * Get the domain of a entity
     * @param entityId QID of an entity
     * @returns its domain, i.e., heuristically the best entity among values of P31 (instance of)
     */
    private async _getEntityType(entityId : string) : Promise<string|null> {
        return this._wikidata.getDomain(entityId);
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
        if (type && qualifiers.length > 0) {
            const fields : Record<string, Ast.ArgumentDef> = {
                value: new Ast.ArgumentDef(null, null, 'value', elemType(type))
            };
            for (const qualifier of qualifiers) {
                const pid = qualifier.slice(PROPERTY_QUALIFIER_PREFIX.length);
                const label = (await this._wikidata.getLabel(pid))!;
                const qname = cleanName(label);
                const qtype = await this._getPropertyTypeHelper(pid, qname);
                // skip if it does not has a supported type,
                if (!qtype)
                    continue;
                const annotation = { 
                    nl: { canonical: await this._generatePropertyCanonicals(qualifier, label, qtype) }, 
                    impl: { wikidata_id: new Ast.Value.String(qualifier) } 
                };
                fields[qname] = new Ast.ArgumentDef(null, null, qname, qtype, annotation);
            }
            // if there is more than 1 (value) fields, create a compound type
            if (Object.keys(fields).length > 1) {
                const compoundType = new Type.Compound(null, fields);
                type = type instanceof Type.Array ? new Type.Array(compoundType) : compoundType;
            }
        }
        this._propertyTypes[propertyId] = type;
        return type;
    }

    private async _getPropertyTypeHelper(propertyId : string, propertyName : string) {
        if (propertyId === 'P21')
            return new Type.Enum(['female', 'male']);

        const wikibaseType = await this._wikidata.getPropertyType(propertyId);
        if (wikibaseType === 'String' || wikibaseType === 'Monolingualtext')
            return Type.String;
        if (wikibaseType === 'Url')
            return new Type.Entity('tt:url');
        if (wikibaseType === 'CommonsMedia')
            return new Type.Entity('tt:picture');
        if (wikibaseType === 'Time')
            return Type.Date;
        if (wikibaseType === 'Quantity') {       
            const units = await this._wikidata.getAllowedUnits(propertyId);
            if (units.length > 0) {
                if (units.includes('kilogram'))
                    return new Type.Measure('kg');
                if (units.includes('metre') ||  units.includes('kilometre'))
                    return new Type.Measure('m');
                if (units.includes('second') || units.includes('year') || units.includes(('minute') || units.includes('hour') || units.includes('day')))
                    return new Type.Measure('ms');
                if (units.includes('degree Celsius'))
                    return new Type.Measure('C');
                if (units.includes('metre per second') || units.includes('kilometre per second'))
                    return new Type.Measure('mps');
                if (units.includes('square metre') || units.includes('square kilometre'))
                    return new Type.Measure('m2');
                if (units.includes('cubic metre'))
                    return new Type.Measure('m3');
                if (units.includes('percent'))
                    return Type.Number;
                if (units.includes('United States dollar'))
                    return Type.Currency;
                if (units.includes('human')) // capacity
                    return Type.Number;
                if (units.includes('radian'))
                    return Type.Number;
                if (units.includes('years old') || units.includes('annum'))
                    return Type.Number;
                console.log(`Unsupported measurement type with unit ${units.join(', ')} for ${propertyId}, use Number instead`);
            }
            return Type.Number;
        }
        if (wikibaseType === 'GlobeCoordinate')
            return Type.Location;
        if (wikibaseType === 'WikibaseItem')
            return new Type.Array(new Type.Entity(`org.wikidata:p_${propertyName}`));
        
        // unsupported
        return null;
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
     * Add an entity type to entities.json, if the entity type already exists, 
     * update the subtype_of field if needed
     * @param type the entity type 
     * @param name the name of the entity
     * @param subtype_of parent types 
     */
    private _addEntity(type : string, name : string, subtype_of : string[]|null = null) {
        if (type in this._entities) {
            if (!subtype_of)
                return;
            if (!this._entities[type].subtype_of)
                this._entities[type].subtype_of = []; 
            for (const parent of subtype_of) {
                if (!this._entities[type].subtype_of?.includes(parent))
                    this._entities[type].subtype_of?.push(parent);
            }
        } else {
            this._entities[type] = {
                type: `org.wikidata:${type}`,
                name, 
                is_well_known: false,
                has_ner_support: true,
                subtype_of 
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
                    this._propertiesByDomainInQald[domain] = new Set();
                }
            }
            for (const triple of triples) {
                if ((triple.subject as IriTerm).termType === 'NamedNode') {
                    const entityId = triple.subject.value.slice(ENTITY_PREFIX.length);
                    const domain = await this._getEntityType(entityId);
                    if (!domain)
                        continue;
                    for (const property of extractProperties(triple.predicate)) {
                        if (!(domain in this._propertiesByDomainInQald))
                            this._propertiesByDomainInQald[domain] = new Set();
                        this._propertiesByDomainInQald[domain].add(property);
                    }
                } else if ((triple.subject as VariableTerm).termType === 'Variable' && triple.subject.value in variables) {
                    const domain = variables[triple.subject.value];
                    for (const property of extractProperties(triple.predicate)) {
                        if (!(domain in this._propertiesByDomainInQald))
                            this._propertiesByDomainInQald[domain] = new Set();
                        this._propertiesByDomainInQald[domain].add(property);
                    }
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
        const entityValues = Object.values(propertyValues).flat().filter(this._wikidata.isEntity);
        const valueLabels = await this._wikidata.getLabelsByBatch(...entityValues);
        for (const [property, values] of Object.entries(propertyValues)) {
            const label = propertyLabels[property] ?? property;
            if (label.startsWith('category for') || label.startsWith('category of'))
                continue;
            const pname = cleanName(label);
            const ptype = await this._getPropertyType(domain, property, pname);
            if (!ptype) 
                continue;
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
            if (!(property in this._properties))
                this._properties[property] = argumentDef;
            // TODO: separate property values by domain
            if (values.length === 0)
                continue;
            const vtype = elemType(ptype);
            if (vtype instanceof Type.Entity) {
                if (!(pname in this._propertyValues.entities))
                    this._propertyValues.entities[pname] = {};
                const valueTypes : Set<string> = new Set();
                for (const value of values) {
                    if (value in this._propertyValues.entities[pname])
                        continue;
                    if (!this._wikidata.isEntity(value))
                        continue;
                    this._propertyValues.entities[pname][value] = valueLabels[value] ?? value;

                    if (this._typeSystem === 'flat')
                        continue; 
                    const type = await this._getEntityType(value);
                    if (type) {
                        const typeLabel = await this._wikidata.getLabel(type);
                        if (typeLabel && typeLabel !== 'entity') {
                            valueTypes.add(`org.wikidata:${cleanName(typeLabel)}`);
                            this._addEntity(cleanName(typeLabel), typeLabel, ['org.wikidata:entity']);
                        }
                    }
                }
                this._addEntity(
                    `p_${pname}`, 
                    label, 
                    this._typeSystem === 'flat' ? ['org.wikidata:entity'] : [...valueTypes]
                );
            }
            if (vtype === Type.String) {
                if (!(pname in this._propertyValues.strings))
                    this._propertyValues.strings[pname] = [];
                for (const value of values)
                    this._propertyValues.strings[pname].push(value);
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
        this._addEntity(fname, domainLabel, ['org.wikidata:entity']);
        const samples = await this._wikidata.getEntitiesByDomain(domain); 
        const sampleLabels = await this._wikidata.getLabelsByBatch(...samples);
        this._domainSamples[fname] = sampleLabels;
        
        // get all properties by sampling Wikidata
        const args = await this._processDomainProperties(domain, fname);
        const missing = [];
        // check missing properties in QALD (do not add it, just check) 
        for (const [id, label] of Object.entries(this._propertiesByDomainInQald[domain] ?? {})) {
            const pname = cleanName(label);
            if (args.some((a) => a.name === pname) || id === 'P31')
                continue;
            missing.push([id, label]);
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
        for (const domain in this._domainLabels) {
            if (domain === 'Q35120') // skip "entity" domain
                continue;
            const [fname, functionDef] = await this._processDomain(domain);
            queries[fname] = functionDef;
        }
        queries['entity'] = new Ast.FunctionDef(null, 'query', null, 'entity',[], {
            is_list: true,
            is_monitorable: false
        }, [idArgument('entity'), ...Object.values(this._properties)], {
            nl: { canonical: ['entity'] },
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
        // write entity dataset for ids 
        for (const [fname, values] of Object.entries(this._domainSamples)) {
            index.write(`entity\ten-US\torg.wikidata:${fname}\tparameter-datasets/${fname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/${fname}.json`);
            const data : Record<string, any> = { result: "ok", data: [] };
            for (const [value, display] of Object.entries(values)) {
                if (display) {
                    const tokenized = this._tokenizer.tokenize(display);
                    data.data.push({ value: value, name: display, canonical: tokenized.rawTokens.join(' ') });
                }
            }
            paramDataset.end(JSON.stringify(data, undefined, 2));
            await waitFinish(paramDataset);
        }
        // write entity dataset for other properties
        for (const [pname, values] of Object.entries(this._propertyValues.entities)) {
            index.write(`entity\ten-US\torg.wikidata:p_${pname}\tparameter-datasets/p_${pname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/p_${pname}.json`);
            const data : Record<string, any> = { result: "ok", data: [] };
            for (const [value, display] of Object.entries(values)) {
                if (display) {
                    const tokenized = this._tokenizer.tokenize(display);
                    data.data.push({ value: value, name: display, canonical: tokenized.rawTokens.join(' ') });
                }
            }
            paramDataset.end(JSON.stringify(data, undefined, 2));
            await waitFinish(paramDataset);
        }
        // write string dataset for properties
        for (const [pname, values] of Object.entries(this._propertyValues.strings)) {
            index.write(`string\ten-US\torg.wikidata:p_${pname}\tparameter-datasets/p_${pname}.tsv\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/p_${pname}.tsv`);
            const output = csvstringify({ header: false, delimiter: '\t' });
            for (const value of values) {
                const tokenized = this._tokenizer.tokenize(value);
                output.write([value, tokenized.rawTokens.join(' '), 1]);
            }
            output.end();
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

    async _loadDomains() {
        await this._wikidata.loadAllDomains();
        this._subdomains = this._wikidata.subdomains;
        for (const domain in this._subdomains) {
            const domainLabel = await this._wikidata.getLabel(domain);
            if (!domainLabel)
                throw new Error('Failed to find label for domain: ' + domain);
            this._domainLabels[domain] = domainLabel;
        }
    }

    /**
     * Process all examples in QALD and then generate/output the manifest and parameter datasets
     */
    async generate() {
        await this._loadDomains();
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
    parser.add_argument('--type-system', {
        required: false,
        choices: ['flat', 'hierarchical'],
        help: 'design choices for the type system:\n' +
            'flat: one entity type per property\n' +
            'hierarchical: one entity type for each value, and the property type is the supertype of all types of its values\n',
        default: 'hierarchical'
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--exclude-non-entity-properties', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--use-wikidata-alt-labels', {
        action: 'store_true',
        help: 'Enable wikidata alternative labels as annotations.',
        default: false
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });
    const args = parser.parse_args();
    const generator = new ManifestGenerator(args);
    generator.generate();
}

main();
