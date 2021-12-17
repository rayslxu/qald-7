import * as fs from 'fs';
import * as argparse from 'argparse';
import { Ast, Type } from 'thingtalk';
import { Parser, SparqlParser, AskQuery, IriTerm, VariableTerm } from 'sparqljs';
import { extractProperties, extractTriples } from './utils/sparqljs';
import { Example, preprocessQALD } from './utils/qald';
import { snakeCase, waitFinish, idArgument } from './utils/misc';
import WikidataUtils from './utils/wikidata';
import { PROPERTY_PREFIX, ENTITY_PREFIX } from './utils/wikidata';

interface ManifestGeneratorOptions {
    output : fs.WriteStream,
    include_non_entity_properties : boolean
}


class ManifestGenerator {
    private _wikidata : WikidataUtils;
    private _parser : SparqlParser;
    private _examples : Example[];
    private _domainLabels : Record<string, string>; // Record<domain, domain label>
    private _propertyLabelsByDomain : Record<string, Record<string, string>>; // Record<domain, Record<PID, property label>
    private _properties : Record<string, Ast.ArgumentDef>;
    private _output : fs.WriteStream;

    private _includeNonEntityProperties : boolean;

    constructor(options : ManifestGeneratorOptions) {
        this._wikidata = new WikidataUtils();
        this._parser = new Parser();
        this._examples = preprocessQALD();
        this._domainLabels = {};
        this._propertyLabelsByDomain = {};
        this._properties = {};
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
        this._propertyLabelsByDomain[entityId][propertyId] = propertyLabel;
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
                this._domainLabels[domain] = await this._wikidata.getLabel(domain);
            }
        }
        for (const triple of triples) {
            if ((triple.subject as IriTerm).termType === 'NamedNode') {
                const entityId = triple.subject.value.slice(ENTITY_PREFIX.length);
                const domain = await this._getEntityDomain(entityId);
                if (!domain)
                    continue;
                const domainLabel = await this._wikidata.getLabel(domain);
                this._domainLabels[domain] = domainLabel;
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
        const args = [idArgument(snakeCase(entityType))];
        const properties = await this._wikidata.getDomainProperties(domain, this._includeNonEntityProperties);
        for (const property of properties) {
            const label = await this._wikidata.getLabel(property);
            const pname = snakeCase(label);
            const argumentDef = new Ast.ArgumentDef(
                null,
                Ast.ArgDirection.OUT,
                pname, 
                new Type.Entity(`org.wikidata:p_${pname}`),
                { 
                    nl: { canonical: { base: [label] } },
                    impl: { wikidata_id: new Ast.Value.String(property) } 
                }
            );
            args.push(argumentDef);
            if (!(label in this._properties))
                this._properties[label] = argumentDef;
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
        const fname = snakeCase(domainLabel);
        // get all properties by sampling Wikidata
        const args = await this._processDomainProperties(domain, fname);
        const missing = [];
        // add missing properties needed by QALD if necessary 
        for (const [id, label] of Object.entries(this._propertyLabelsByDomain[domain])) {
            const pname = snakeCase(label);
            if (args.some((a) => a.name === pname) || id === 'P31')
                continue;
            missing.push([id, label]);
            const argumentDef = new Ast.ArgumentDef(
                null, 
                Ast.ArgDirection.OUT, 
                pname,
                new Type.Entity(`org.wikidata:p_${pname}`) ,
                {
                    nl: { canonical: { base: [label] } },
                    impl: { wikidata_id: new Ast.Value.String(id) }
                }
            );
            args.push(argumentDef);
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
     * Process all examples in QLAD and then generate/output the manifest
     */
    async generate() {
        console.log('Start processing QALD examples ...');
        await this._processExamples();
        console.log(`Done processing QALD examples, ${Object.keys(this._domainLabels).length} domains discovered: `);
        for (const [domain, domainLabel] of Object.entries(this._domainLabels)) 
            console.log(`${domain}: ${domainLabel}`);

        console.log('Start sampling Wikidata for schema ...');
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
        }, [idArgument('entity'), ...Object.values(this._properties)], {});

        console.log('Start writing device manifest ...');
        const whitelist =  new Ast.Value.Array(
            Object.keys(queries).filter((qname) => qname !== 'entity').map((qname) => new Ast.Value.String(qname))
        );
        const classDef = new Ast.ClassDef(null, 'org.wikidata', null, {
            imports, queries
        }, {
            nl: { name: 'WikidataQA', description: 'Question Answering over Wikidata' },
            impl: { whitelist }
        });

        this._output.end(classDef.prettyprint());
        await waitFinish(this._output);
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