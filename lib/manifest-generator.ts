import * as fs from 'fs';
import * as argparse from 'argparse';
import { Ast, Type } from 'thingtalk';
import { 
    Parser, 
    SparqlParser, AskQuery, Triple, IriTerm, VariableTerm, PropertyPath 
} from 'sparqljs';
import { snakeCase, waitFinish } from './utils';
import WikidataUtils from './wikidata-utils';
import trainQuestions from '../data/train.json';
import testQuestions from '../data/test.json';

const ENTITY_PREFIX = 'http://www.wikidata.org/entity/';
const PROPERTY_PREFIX = 'http://www.wikidata.org/prop/direct/';

interface Example {
    id : string,
    utterance : string,
    sparql : string
}

interface ManifestGeneratorOptions {
    output : fs.WriteStream,
    include_non_entity_properties : boolean
}

/**
 * Preprocess one QALD example to extract only useful information for us
 * @param example An example in QALD
 * @returns A cleaned example object with id, utterance, and sparql
 */
function preprocessExample(example : any) : Example {
    return {
        id: example.id,
        utterance: example.question[0].string,
        sparql: example.query.sparql
    };
}

/**
 * Preprocess all QALD train/test examples into a cleaned array
 * @returns An array of examples
 */
function preprocessQALD() : Example[] {
    const questions = [];
    for (const example of trainQuestions.questions) 
        questions.push(preprocessExample(example));
    for (const example of testQuestions.questions) 
        questions.push(preprocessExample(example));
    return questions;
}

/**
 * Given a parsed object returned by sparqljs, extract rdf triples out of it
 * @param obj any object containing 'triples' field at any depth
 * @returns a flattened array of triples 
 */
function extractTriples(obj : any) : Triple[] {
    const triples : Triple[] = [];
    function extract(obj : any) {
        if (obj instanceof Object) {
            for (const [key, value] of Object.entries(obj)) {
                if (key === 'triples') {
                    const flattened = (value as any[]).flat(Infinity);
                    for (const triple of flattened)
                        triples.push(triple); 

                } else {
                    extract(value);
                }
            }
        }
    }
    extract(obj);
    return triples;
}

/**
 * Extract Wikidata properties involved in a predicate 
 * @param predicate A predicate form sparqljs
 * @returns a flattened array of Wikidata properties (E.g, [P31, P279, ...]) 
 */
function extractProperties(predicate : IriTerm|PropertyPath|VariableTerm) : string[] {
    const properties : string[]= [];
    function extract(predicate : IriTerm|PropertyPath|VariableTerm) {
        if ((predicate as IriTerm).termType === 'NamedNode') {
            if ((predicate as IriTerm).value.startsWith(PROPERTY_PREFIX)) 
                properties.push((predicate as IriTerm).value.slice(PROPERTY_PREFIX.length));
        } else {
            for (const item of (predicate as PropertyPath).items) 
                extract(item);
        }
    }
    extract(predicate);
    return properties;
}

class ManifestGenerator {
    private _wikidata : WikidataUtils;
    private _parser : SparqlParser;
    private _examples : Example[];
    private _domains : Record<string, string>; // Record<domain, domain label>
    private _properties : Record<string, Record<string, string>>; // Record<domain, Record<PID, property label>
    private _output : fs.WriteStream;

    private _includeNonEntityProperties : boolean;

    constructor(options : ManifestGeneratorOptions) {
        this._wikidata = new WikidataUtils();
        this._parser = new Parser();
        this._examples = preprocessQALD();
        this._domains = {};
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
        if (!(entityId in this._properties)) 
            this._properties[entityId] = {};
        
        const propertyLabel = await this._wikidata.getLabel(propertyId);
        this._properties[entityId][propertyId] = propertyLabel;
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
                this._domains[domain] = await this._wikidata.getLabel(domain);
            }
        }
        for (const triple of triples) {
            if ((triple.subject as IriTerm).termType === 'NamedNode') {
                const entityId = triple.subject.value.slice(ENTITY_PREFIX.length);
                const domain = await this._getEntityDomain(entityId);
                if (!domain)
                    continue;
                const domainLabel = await this._wikidata.getLabel(domain);
                this._domains[domain] = domainLabel;
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
     */
    private async _processDomain(domain : string, domainLabel : string) {
        const args = [
            new Ast.ArgumentDef(
                null, 
                Ast.ArgDirection.OUT, 
                'id',
                new Type.Entity(`org.wikidata:${snakeCase(domainLabel)}`),
                { nl: { canonical: { base: ['name'], passive_verb: ['named', 'called'] } } }
            )
        ];
        const properties = await this._wikidata.getDomainProperties(domain, this._includeNonEntityProperties);
        for (const property of properties) {
            const label = await this._wikidata.getLabel(property);
            const pname = snakeCase(label);
            args.push(
                new Ast.ArgumentDef(
                    null,
                    Ast.ArgDirection.OUT,
                    pname, 
                    new Type.Entity(`org.wikidata:p_${pname}`),
                    { 
                        nl: { canonical: { base: [label] } },
                        impl: { wikidata_id: new Ast.Value.String(property) } 
                    }
                )
            );
        }
        return args;
    }

    /**
     * Process all examples in QLAD and then generate/output the manifest
     */
    async generate() {
        console.log('Start processing QALD examples ...');
        await this._processExamples();
        console.log(`Done processing QALD examples, ${Object.keys(this._domains).length} domains discovered: `);
        for (const [domain, domainLabel] of Object.entries(this._domains)) 
            console.log(`${domain}: ${domainLabel}`);

        console.log('Start sampling Wikidata for schema ...');
        const imports = [
            new Ast.MixinImportStmt(null, ['loader'], 'org.thingpedia.v2', []),
            new Ast.MixinImportStmt(null, ['config'], 'org.thingpedia.config.none', [])
        ];
        const queries : Record<string, Ast.FunctionDef> = {};
        for (const domain in this._properties) {
            const domainLabel = this._domains[domain];
            console.log(`Sampling ${domainLabel} domain ...`);
            const fname = snakeCase(domainLabel);
            // get all properties by sampling Wikidata
            const args = await this._processDomain(domain, domainLabel);
            const missing = [];
            // add missing properties needed by QALD if necessary 
            for (const [id, label] of Object.entries(this._properties[domain])) {
                const pname = snakeCase(label);
                if (args.some((a) => a.name === pname) || id === 'P31')
                    continue;
                missing.push([id, label]);
                args.push(
                    new Ast.ArgumentDef(
                        null, 
                        Ast.ArgDirection.OUT, 
                        pname,
                        new Type.Entity(`org.wikidata:p_${pname}`) ,
                        {
                            nl: { canonical: { base: [label] } },
                            impl: { wikidata_id: new Ast.Value.String(id) }
                        }
                    )
                );
            }
            console.log(`Done sampling ${domainLabel} domain`);
            console.log(`In total ${args.length} properties sampled, ${missing.length} not covered`);
            if (missing.length > 0)
                console.log(missing.map(([id, label]) => `${label} (${id})`).join(', '));

            const functionDef = new Ast.FunctionDef(null, 'query', null, fname, [], {
                is_list: true, 
                is_monitorable: false
            }, args, {
                nl: { canonical: [domainLabel] },
                impl : {
                    handle_thingtalk: new Ast.Value.Boolean(true),
                    wikidata_subject: new Ast.Value.Array([new Ast.Value.String(domain)])
                }
            });
            queries[fname] = functionDef;
        }

        console.log('Start writing device manifest ...');
        const classDef = new Ast.ClassDef(null, 'org.wikidata', null, {
            imports, queries
        }, {
            nl: { name: 'WikidataQA', description: 'Question Answering over Wikidata' }
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