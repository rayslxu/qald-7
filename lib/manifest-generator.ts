import * as fs from 'fs';
import * as path from 'path';
import * as argparse from 'argparse';
import csvstringify from 'csv-stringify';
import { Ast, Type } from 'thingtalk';
import { I18n, genBaseCanonical } from 'genie-toolkit';
import { Parser, SparqlParser, AskQuery, IriTerm, VariableTerm } from 'sparqljs';
import { extractProperties, extractTriples } from './utils/sparqljs';
import { Example, preprocessQALD } from './utils/qald';
import { cleanName, sampleAltLabels, waitFinish } from './utils/misc';
import { idArgument, elemType, instanceOfArgument, fakeProperty } from './utils/thingtalk';
import WikidataUtils, { ABSTRACT_PROPERTIES, DOMAIN_OVERRIDE } from './utils/wikidata';
import { PROPERTY_PREFIX, ENTITY_PREFIX, TP_DEVICE_NAME } from './utils/wikidata';

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
    domains ?: string
    type_system : 'flat' | 'hierarchical'
    cache : string,
    save_cache : boolean,
    output : fs.WriteStream,
    prompt : fs.WriteStream,
    exclude_non_entity_properties : boolean,
    use_wikidata_alt_labels : boolean,
    human_readable_instance_of : boolean,
    bootleg_db : string,
    canonical_annotations : boolean;
}

class ManifestGenerator {
    private _experiment : 'qald7'|'qald9';
    private _domains : string[];
    private _typeSystem : 'flat' | 'hierarchical';
    private _wikidata : WikidataUtils;
    private _parser : SparqlParser;
    private _tokenizer : I18n.BaseTokenizer;
    private _examples : Example[];
    private _entities : Record<string, Entity>;
    private _domainLabels : Record<string, string>; // Record<QID, domain label>
    private _subdomains : Record<string, string[]>; // subdomains for each domain
    private _domainSamples : Record<string, Record<string, string|null>>; // Record<QID, entities> 
    private _datasetProperties : Record<string, Set<string>>; // Record<PID, Set<QID>>, properties in dataset examples and domain they are used
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
    private _prompt : fs.WriteStream;

    private _includeNonEntityProperties : boolean;
    private _useWikidataAltLabels : boolean;
    private _humanReadableInstanceOf : boolean;
    private _canonicalAnnotations : boolean;

    constructor(options : ManifestGeneratorOptions) {
        this._experiment = options.experiment;
        this._domains = options.domains? options.domains.split(',') : [];
        this._typeSystem = options.type_system;
        this._wikidata = new WikidataUtils(options.cache, options.bootleg_db, options.save_cache);
        this._parser = new Parser();
        this._tokenizer = new I18n.LanguagePack('en-US').getTokenizer();
        this._examples = preprocessQALD(options.experiment);
        this._domainLabels = {};
        this._subdomains = {};
        this._domainSamples = {};
        this._entities = {};
        this._datasetProperties = {};
        this._properties = {};
        this._propertyValues = { entities: {}, strings: {} };
        this._propertyTypes = {};
        this._output = options.output;
        this._prompt = options.prompt;

        this._includeNonEntityProperties = !options.exclude_non_entity_properties;
        this._useWikidataAltLabels = options.use_wikidata_alt_labels;
        this._humanReadableInstanceOf = options.human_readable_instance_of;
        this._canonicalAnnotations = options.canonical_annotations;
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
    private async _getPropertyType(propertyId : string, propertyName : string) {
        if (propertyId in this._propertyTypes) 
            return this._propertyTypes[propertyId];
        let type = await this._getPropertyTypeHelper(propertyId, propertyName);
        const qualifiers = await this._wikidata.getQualifiersByProperty(propertyId);
        // HACK: force occupation to have start time and end time
        if (propertyId === 'P106')
            qualifiers.push('P580', 'P582');
        // HACK: force position_held to have electoral_district
        if (propertyId === 'P39')
            qualifiers.push('P768');
        // HACK: force spouse to have place of marriage
        if (propertyId === 'P26')
            qualifiers.push('P2842');
        // HACK: force point in time for draft by
        if (propertyId === 'P647')
            qualifiers.push('P585');
        // HACK: force point in time for notable work
        if (propertyId === 'P800')
            qualifiers.push('P585');
        // HACK: force point in time and "for work" for winner
        if (propertyId === 'P1346')
            qualifiers.push('P585', 'P1686');
        // HACK: force "object has role" for has parts
        if (propertyId === 'P527')
            qualifiers.push('P3831');
        // HACK: force location to have point_in_time
        if (propertyId === 'P276')
            qualifiers.push('P580');

        // make sure start time and end time come in pairs 
        if (qualifiers.includes('P580') && !qualifiers.includes('P582'))
            qualifiers.push('P582');
        if (qualifiers.includes('P582') && !qualifiers.includes('P580'))
            qualifiers.push('P580');

        if (qualifiers.includes('P580') || qualifiers.includes('P582'))
            qualifiers.push('P585');
        
        if (type && qualifiers.length > 0) {
            const fields : Record<string, Ast.ArgumentDef> = {
                value: new Ast.ArgumentDef(null, null, 'value', elemType(type))
            };
            for (const qualifier of qualifiers) {
                const pid = qualifier;
                const label = (await this._wikidata.getLabel(pid))!;
                const qname = cleanName(label);
                const qtype = await this._getPropertyTypeHelper(pid, qname);
                // skip if it does not has a supported type,
                if (!qtype)
                    continue;
                const annotations : Record<string, any> = { 
                    impl: { wikidata_id: new Ast.Value.String(pid) } 
                };
                if (this._canonicalAnnotations)
                    annotations.nl = { canonical: await this._generatePropertyCanonicals(pid, label, elemType(qtype)) };
                fields[qname] = new Ast.ArgumentDef(null, null, qname, elemType(qtype), annotations);
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
            return new Type.Array(new Type.Entity(`${TP_DEVICE_NAME}:p_${propertyName}`));
        
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
            labels.push(...sampleAltLabels(altLabels));
        } 
        const baseCanonical : Record<string, any> = {};
        if (['P106', 'P27'].includes(id)) // occupation and country of citizenship
            baseCanonical.reverse_property = ["#"];
        for (const label of labels) 
            genBaseCanonical(baseCanonical, label, type, null);

        // copy annotation to projections
        for (const key in baseCanonical) {
            if (key === 'default')
                continue;
            if (key.endsWith('_true') || key.endsWith('_false'))
                continue;
            if (key.endsWith('_projection'))
                continue;
            if (key === 'base' && !('property' in baseCanonical)) {
                baseCanonical['property'] = baseCanonical[key]; 
                baseCanonical['property_projection'] = baseCanonical[key];
            }
            if (!((key + '_projection') in baseCanonical)) {
                baseCanonical[key + '_projection'] = [];
                for (const value of baseCanonical[key]) {
                    if (!value.includes('#'))
                        baseCanonical[key + '_projection'].push(value);
                }
            }
        }
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
                type: `${TP_DEVICE_NAME}:${type}`,
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
                }
            }
            for (const triple of triples) {
                let domain = 'Q35120';
                if ((triple.subject as IriTerm).termType === 'NamedNode') {
                    const entityId = triple.subject.value.slice(ENTITY_PREFIX.length);
                    const entityDomain = await this._getEntityType(entityId);
                    if (entityDomain)
                        domain = entityDomain;
                } else if ((triple.subject as VariableTerm).termType === 'Variable' && triple.subject.value in variables) {
                    domain = variables[triple.subject.value];
                }
                for (const property of extractProperties(triple.predicate)) {
                    if (!(property in this._datasetProperties))
                        this._datasetProperties[property] = new Set();
                    this._datasetProperties[property].add(domain);
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

    private async _addValues(argumentDef : Ast.ArgumentDef, pname : string, plabel : string, values : string[], valueLabels : Record<string, string|null>) {
        const vtype = elemType(argumentDef.type);
        if (vtype instanceof Type.Entity && vtype.type.startsWith(TP_DEVICE_NAME)) {   
            if (!(pname in this._propertyValues.entities))
                this._propertyValues.entities[pname] = {};
            const valueTypes : Set<string> = new Set();
            const valueTypeQIDs : string[] = [];
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
                    valueTypeQIDs.push(type);
                    const typeLabel = await this._wikidata.getLabel(type);
                    if (typeLabel) {
                        const parentClasses = typeLabel === 'entity' ? [] : [`${TP_DEVICE_NAME}:entity`];
                        valueTypes.add(`${TP_DEVICE_NAME}:${cleanName(typeLabel)}`);
                        this._addEntity(cleanName(typeLabel), typeLabel, parentClasses);
                    }
                }
            }
            this._addEntity(
                `p_${pname}`, 
                plabel, 
                this._typeSystem === 'flat' ? [`${TP_DEVICE_NAME}:entity`] : [...valueTypes]
            );

            if (this._canonicalAnnotations) {
                if (valueTypeQIDs.includes('Q5')) {
                    argumentDef.nl_annotations['canonical']['projection_pronoun'] = 'who';
                } else {
                    const locationTypes = await this._wikidata.getSubdomains('Q17334923');
                    if (valueTypeQIDs.filter((t) => locationTypes.includes(t)).length >= Math.min(valueTypeQIDs.length * 0.5, 1))
                        argumentDef.nl_annotations['canonical']['projection_pronoun'] = 'where';
                }
            }
        }
        if (vtype === Type.String) {
            if (!(pname in this._propertyValues.strings))
                this._propertyValues.strings[pname] = [];
            for (const value of values)
                this._propertyValues.strings[pname].push(value);
        }
        // load compound fields
        if (elemType(argumentDef.type, false) instanceof Type.Compound) {
            const compoundType = elemType(argumentDef.type, false) as Type.Compound;
            for (const [fname, field] of Object.entries(compoundType.fields)) {
                if (fname === 'value')
                    continue;
                const pid : string = field.getImplementationAnnotation('wikidata_id')!;
                const label = (await this._wikidata.getLabel(pid))!;
                const values = await this._wikidata.getQualifierValues(pid);
                const valueLabels = await this._wikidata.getLabelsByBatch(...values);
                await this._addValues(field, fname, label, values, valueLabels);
            }
        }
    }

    /**
     * Query Wikidata to obtain common properties of a domain
     * @param domain QID of a domain
     * @param entityType snake cased label of the domain
     */
    private async _processDomainProperties(domain : string, entityType : string) {
        const args = [idArgument(cleanName(entityType)), instanceOfArgument(entityType)];
        const propertyValues = await this._wikidata.getDomainPropertiesAndValues(domain, this._includeNonEntityProperties);
        // hack: 
        // - start time and end time always come in pairs
        // - if there are start time & end time, also add point in time (but not vice versa)
        if ('P580' in propertyValues || 'P582' in propertyValues) {
            for (const p of ['P580', 'P582', 'P585']) 
                propertyValues[p] = [];
        }
        for (const [abstractProperty, abstraction] of Object.entries(ABSTRACT_PROPERTIES)) {
            const abstractPropertyValues = propertyValues[abstractProperty] ?? [];
            for (const realProperty of abstraction.properties) {
                if (realProperty in propertyValues)
                    abstractPropertyValues.push(...propertyValues[realProperty]);
            }
            if (abstractPropertyValues.length > 0)
                propertyValues[abstractProperty] = abstractPropertyValues;
        }
 
        const propertyLabels = await this._wikidata.getLabelsByBatch(...Object.keys(propertyValues));
        const entityValues = Object.values(propertyValues).flat().filter(this._wikidata.isEntity);
        const valueLabels = await this._wikidata.getLabelsByBatch(...entityValues);

        for (const [property, values] of Object.entries(propertyValues)) {
            const label = propertyLabels[property] ?? property;
            if (label.startsWith('category for') || label.startsWith('category of'))
                continue;
            const pname = cleanName(label);
            const ptype = await this._getPropertyType(property, pname);
            // skip property with unsupported type
            if (!ptype) 
                continue;
            // skip property with location type that is not "coordinate location"
            if (property !== 'P625' && ptype === Type.Location)
                continue;
            const annotations : Record<string, any> = { impl: { wikidata_id: new Ast.Value.String(property) } };
            // Do not filter on coordinate location, this is not useful in Wikidata setting
            if (property === 'P625')
                annotations.impl.filterable = new Ast.Value.Boolean(false);
            if (this._canonicalAnnotations)
                annotations.nl = { canonical: await this._generatePropertyCanonicals(property, label, ptype) };
            const argumentDef = new Ast.ArgumentDef(
                null,
                Ast.ArgDirection.OUT,
                pname, 
                ptype,
                annotations
            );
            if (this._canonicalAnnotations) {
                if (pname.startsWith('located_') || pname.startsWith('location_of_') || pname.endsWith('_location'))
                    argumentDef.nl_annotations['canonical']['projection_pronoun'] = 'where';
                else if (pname.startsWith('cause_of'))
                    argumentDef.nl_annotations['canonical']['projection_pronoun'] = 'how';
            }
            if (values.length > 0) 
                this._addValues(argumentDef, pname, label, values, valueLabels);

            args.push(argumentDef);
            if (!(property in this._properties))
                this._properties[property] = argumentDef;
        }
        return args;
    }

    /**
     * Get a thingtalk query for a domain
     * @param domain QID of a domain
     * @returns A function definition of this domain
     */
    private async _processDomain(domain : string) : Promise<[string, Ast.FunctionDef|null]> {
        const domainLabel = this._domainLabels[domain];
        console.log(`Sampling ${domainLabel} domain ...`);
        domain = DOMAIN_OVERRIDE[domain] ?? domain;
        const fname = cleanName(domainLabel);
        this._addEntity(fname, domainLabel, fname === 'entity' ? [] : [`${TP_DEVICE_NAME}:entity`]);
        this._addEntity(fname + '_subdomain', `Subdomains of ${domainLabel} (${domain})`, null);
        this._addEntity('domain', `All domains`, [`${TP_DEVICE_NAME}:${fname}_subdomain`]);
        const samples = await this._wikidata.getEntitiesByDomain(domain); 
        const sampleLabels = await this._wikidata.getLabelsByBatch(...samples);
        this._domainSamples[fname] = sampleLabels;

        if (fname === 'entity') // skip the rest for "entity" domain
            return [fname, null];

        // get all properties by sampling Wikidata
        const args = await this._processDomainProperties(domain, fname);
        console.log(`Done sampling ${domainLabel} domain`);
        console.log(`In total ${args.length} properties sampled`);


        const canonical = [domainLabel];
        if (this._useWikidataAltLabels) {
            const altLabels = await this._wikidata.getAltLabels(domain);
            canonical.push(...altLabels);
        }
        const annotations : Record<string, any> = {
            nl : {
                canonical,
                result: ["Result:"],
                formatted: {
                    type: "rdl",
                    displayTitle: "${title}",
                    webCallback: "${link}",
                } 
            },
            impl : {
                inherit_arguments: new Ast.Value.Boolean(false),
                handle_thingtalk: new Ast.Value.Boolean(true),
                wikidata_subject: new Ast.Value.Array([new Ast.Value.String(domain)])
            }
        };
        const functionDef = new Ast.FunctionDef(null, 'query', null, fname, ['entity'], {
            is_list: true, 
            is_monitorable: false
        }, args, annotations);
        return [fname, functionDef];
    }

    /**
     * Generate the manifest 
     * @returns the class definition 
     */
    async _generateManifest() : Promise<Ast.ClassDef> {
        let countTotalProperties = 0;

        // imports
        const imports = [
            new Ast.MixinImportStmt(null, ['loader'], 'org.thingpedia.v2', []),
            new Ast.MixinImportStmt(null, ['config'], 'org.thingpedia.config.none', [])
        ];

        // queries
        const queries : Record<string, Ast.FunctionDef> = {};
        for (const domain in this._domainLabels) {
            const [fname, functionDef] = await this._processDomain(domain);
            if (functionDef) {
                queries[fname] = functionDef;
                countTotalProperties += functionDef.args.length;
            }
        }
        const countQueries = Object.keys(queries).length;
        console.log(`In total: ${Object.keys(this._properties).length + 1} Wikidata properties included.`);
        console.log(`${Object.values(this._properties).filter((p) => p.type instanceof Type.Compound).length} of them have qualifiers`);
        console.log(`On average, there are ${countTotalProperties / countQueries} in each of the ${countQueries} domains`);
        // create a special property just to represent sparql that we cannot handle.
        this._properties['_predicate'] = new Ast.ArgumentDef(
            null,
            Ast.ArgDirection.OUT,
            '_predicate',
            Type.String,
            {
                impl: {  
                    projectable: new Ast.Value.Boolean(false), 
                    filterable: new Ast.Value.Boolean(false)
                }
            }
        );
        for (const id in this._datasetProperties) {
            if (id === 'P31')
                continue;
            const label = await this._wikidata.getLabel(id);
            const pname = cleanName(label!);
            const type = await this._getPropertyType(id, pname);
            if (!(id in this._properties)) {
                // add entity 
                this._addEntity(
                    `p_${pname}`, 
                    label!, 
                    [`${TP_DEVICE_NAME}:entity`]
                );
                // add property
                this._properties[id] = fakeProperty(id, pname, type ?? undefined);
            }

            for (const domain of this._datasetProperties[id]) {
                const domainLabel = this._domainLabels[domain];
                
                // add to the dedicated domain for domain that is not "entity" (Q35120)
                if (domain === 'Q35120' || !domainLabel)
                    continue;
                const fname = cleanName(domainLabel);
                const oldFunctionDef = queries[fname];
                if (oldFunctionDef.hasArgument(pname))
                    continue;

                console.log(`Adding missing property in domain ${domain}: ${pname} (${id}, type: ${type})`);
                const args = oldFunctionDef.args.map((arg) => oldFunctionDef.getArgument(arg)!);
                args.push(this._properties[id]);
                queries[fname] = new Ast.FunctionDef(null, 'query', null, fname, ['entity'], {
                    is_list: true, 
                    is_monitorable: false
                }, args, {
                    nl: oldFunctionDef.nl_annotations,
                    impl: oldFunctionDef.impl_annotations
                });
            }
        }

        const annotations : Record<string, any> = {
            nl: { 
                canonical: ['entity'],
                result: ["Result:"],
                formatted: {
                    type: "rdl",
                    displayTitle: "${title}",
                    webCallback: "${link}",
                } 
            },
            impl : {
                handle_thingtalk: new Ast.Value.Boolean(true),
                wikidata_subject: new Ast.Value.Array([new Ast.Value.String('Q35120')])
            }
        };
        queries['entity'] = new Ast.FunctionDef(null, 'query', null, 'entity',[], {
            is_list: true,
            is_monitorable: false
        }, [idArgument('entity'), instanceOfArgument('entity'), ...Object.values(this._properties)], annotations);

        // entity declarations
        this._addEntity('entity', 'Entity');
        this._addEntity('domain', 'Domain');
        this._addEntity('entity_subdomain', `Subdomains for all entities`, null);
        this._addEntity('domain', `Domains`, [`${TP_DEVICE_NAME}:entity_subdomain`]);
        const entities : Ast.EntityDef[] = Object.values(this._entities).map((entity) => {
            return new Ast.EntityDef(
                null,
                entity.type.slice(`${TP_DEVICE_NAME}:`.length),
                (entity.subtype_of ?? []).map((e) => e.slice(`${TP_DEVICE_NAME}:`.length)),
                { 
                    nl: { description: entity.name },
                    impl: { has_ner: new Ast.Value.Boolean(!!entity.has_ner_support) } 
                }
            );
        });

        console.log('Start writing device manifest ...');
        const whitelist =  new Ast.Value.Array(
            Object.keys(queries).map((qname) => new Ast.Value.String(qname))
        );
        return new Ast.ClassDef(null, TP_DEVICE_NAME, null, {
            imports, queries, entities
        }, {
            nl: { name: `WikidataQA based on ${this._experiment}`, description: 'Question Answering over Wikidata' },
            impl: { whitelist }
        });
    }

    /**
     * Output the parameter datasets 
     */
    async _outputParameterDatasets(classDef : Ast.ClassDef) {
        const dir = path.dirname(this._output.path as string);
        const index = fs.createWriteStream(dir + '/parameter-datasets.tsv');
        // write entity dataset for ids 
        for (const [fname, values] of Object.entries(this._domainSamples)) {
            index.write(`entity\ten-US\t${TP_DEVICE_NAME}:${fname}\tparameter-datasets/${fname}.json\n`);
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
        // write entity dataset for instanceof 
        const domainEntities : Record<string, any> = {};
        for (const [domain, values] of Object.entries(this._wikidata.subdomains)) {
            if (this._domains.length > 0 && !this._domains.includes(domain))
                continue;
            const fname = cleanName(this._domainLabels[domain]);
            index.write(`entity\ten-US\t${TP_DEVICE_NAME}:${fname}_subdomain\tparameter-datasets/${fname}.json\n`);
            const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/${fname}_subdomain.json`);
            const data : Record<string, any> = { result: "ok", data: [] };
            for (const value of values) {
                const display = await this._wikidata.getLabel(value);
                if (display) {
                    const tokenized = this._tokenizer.tokenize(display);
                    const name = tokenized.rawTokens.join(' ');
                    if (this._humanReadableInstanceOf)
                        domainEntities[name] = { value: name, name: `${display} (${value})`, canonical: name };
                    else 
                        domainEntities[name] = { value, name: display, canonical: name };
                    data.data.push(domainEntities[name]);
                }
            }
            paramDataset.end(JSON.stringify(data, undefined, 2));
            await waitFinish(paramDataset);
        }
        // add top-level domains as well
        for (const query of Object.values(classDef.queries)) {
            const qid = (query.getImplementationAnnotation('wikidata_subject') as string[])[0];
            const display = (query.getNaturalLanguageAnnotation('canonical') as string[])[0] ;
            const tokenized = this._tokenizer.tokenize(display);
            const name = tokenized.rawTokens.join(' ');
            if (this._humanReadableInstanceOf)
                domainEntities[name] = { value: name, name: `${display} (${qid})`, canonical: name };
            else 
                domainEntities[name] = { value: qid, name: display, canonical: name };
        }
        const paramDataset = fs.createWriteStream(dir + `/parameter-datasets/domain.json`);
        paramDataset.end(JSON.stringify({ result: "ok", data: Object.values(domainEntities) }, undefined, 2));
        await waitFinish(paramDataset);

        // write entity dataset for other properties
        for (const [pname, values] of Object.entries(this._propertyValues.entities)) {
            index.write(`entity\ten-US\t${TP_DEVICE_NAME}:p_${pname}\tparameter-datasets/p_${pname}.json\n`);
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
            index.write(`string\ten-US\t${TP_DEVICE_NAME}:p_${pname}\tparameter-datasets/p_${pname}.tsv\n`);
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
            if (this._domains.length > 0 && !this._domains.includes(domain))
                continue;
            const domainLabel = await this._wikidata.getLabel(domain);
            if (!domainLabel)
                throw new Error('Failed to find label for domain: ' + domain);
            this._domainLabels[domain] = domainLabel;
            for (const subdomain of this._subdomains[domain]) {
                const subdomainLabel = await this._wikidata.getLabel(subdomain);
                if (subdomainLabel)
                    this._addEntity(cleanName(subdomainLabel), subdomainLabel, [`${TP_DEVICE_NAME}:entity`]);
            }
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
        await this._outputParameterDatasets(classDef);
        console.log('Done.');
        
        console.log('Start generating schema prompt ...');
        const prompt = [];
        prompt.push('Translate natural language into SPARQL to query Wikidata.');
        prompt.push('# Domains in Wikidata:');
        for (const [domain, domainLabel] of Object.entries(this._domainLabels))
            prompt.push(`# ${domainLabel}: ${domain}`);
        prompt.push('# Properties in Wikidata:');
        for (const arg of Object.values(this._properties))
            prompt.push(`# ${arg.canonical}: ${arg.getImplementationAnnotation('wikidata_id')}`);
        this._prompt.end(prompt.join('\n'));
        await waitFinish(this._prompt);
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
    parser.add_argument('--prompt', {
        required: false,
        default: 'prompt.txt',
        type: fs.createWriteStream
    });
    parser.add_argument('--experiment', {
        required: false,
        default: 'qald7'
    });
    parser.add_argument('--domains', {
        required: false,
        help: 'a list of domains to include, separated by comma, if absent, include all domains'
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
    parser.add_argument('--save-cache', {
        action: 'store_true',
        default: false
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
    parser.add_argument('--human-readable-instance-of', {
        action: 'store_true',
        help: 'Use human readable string for instance_of instead of QID.',
        default: false
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });
    parser.add_argument('--canonical-annotations', {
        required: false,
        action: 'store_true',
        default: true,
        help: 'Include canonical annotations in the manifest'
    });
    parser.add_argument('--no-canonical-annotations', {
        required: false,
        action: 'store_false',
        dest: 'canonical_annotations',
        help: 'Exclude canonical annotations in the manifest'
    });
    const args = parser.parse_args();
    const generator = new ManifestGenerator(args);
    generator.generate();
}

main();
