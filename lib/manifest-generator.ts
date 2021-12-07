/**
 * Generate a manifest from QALD-7 dataset 
 * 
 * Domains:
 *   all domains in QALD-7
 *   option 1:
 *     for each subject, get P31 values, pick the most popular one (by instance count)
 *     and every type extends entity.
 *   option 2: 
 *     for each subject, get P31 values, and then P279 all the way up to entity
 *     (potentially stop at properties with small instance count)
 *     build the entities.json
 *     then add queries with "extends" based on entities.json
 *     issue: how do we distribute properties?
 * 
 * Properties: 
 *   random example for each domain, and extract properties
 * 
 * Values: 
 *   sample 100 values each
 * 
 */

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
const PROPERTY_PREFIX = 'http://www.wikidata.org/prop/direct/'

interface Example {
    id : string,
    utterance : string,
    sparql : string
}

interface ManifestGeneratorOptions {
    output : fs.WriteStream
}

function preprocessExample(example : any) : Example {
    return {
        id: example.id,
        utterance: example.question[0].string,
        sparql: example.query.sparql
    };
}

function preprocessQALD() : Example[] {
    const questions = [];
    for (const example of trainQuestions.questions) 
        questions.push(preprocessExample(example));
    for (const example of testQuestions.questions) 
        questions.push(preprocessExample(example));
    return questions;
}

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
    };
    extract(obj);
    return triples;
}

function extractProperties(predicate : IriTerm|PropertyPath|VariableTerm) : string[] {
    const properties : string[]= [];
    function extract(predicate : IriTerm|PropertyPath|VariableTerm) {
        if ((predicate as IriTerm).termType === 'NamedNode') {
            if ((predicate as IriTerm).value.startsWith(PROPERTY_PREFIX)) 
                properties.push((predicate as IriTerm).value.slice(PROPERTY_PREFIX.length));
        } else {
            for (const item of (predicate as PropertyPath).items) {
                extract(item);
            }
        }
    }
    extract(predicate);
    return properties;
}

class ManifestGenerator {
    private _wikidata : WikidataUtils;
    private _parser : SparqlParser;
    private _examples : Example[];
    private _domains : Record<string, string>;
    private _properties : Record<string, Record<string, string>>;
    private _output : fs.WriteStream;

    constructor(options : ManifestGeneratorOptions) {
        this._wikidata = new WikidataUtils();
        this._parser = new Parser();
        this._examples = preprocessQALD();
        this._domains = {};
        this._properties = {};
        this._output = options.output;
    }

    private async _getEntityDomain(entityId : string) {
        const domains = await this._wikidata.getPropertyValue(entityId, 'P31');
        return domains[0];
    }

    private async _updateProperties(entityId : string, propertyId : string) {
        if (!(entityId in this._properties)) 
            this._properties[entityId] = {};
        
        const propertyLabel = await this._wikidata.getLabel(propertyId);
        this._properties[entityId][propertyId] = propertyLabel;
    }

    private async _processOneExample(example : Example) {
        const parsed = this._parser.parse(example.sparql) as AskQuery;
        const triples = extractTriples(parsed);

        const variables : Record<string, string> = {};
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

    private async _processExamples() {
        for (const example of this._examples) 
            await this._processOneExample(example);
    }

    async generate() {
        await this._processExamples();

        const imports = [
            new Ast.MixinImportStmt(null, ['loader'], 'org.thingpedia.v2', []),
            new Ast.MixinImportStmt(null, ['config'], 'org.thingpedia.config.none', [])
        ];
        const queries : Record<string, Ast.FunctionDef> = {};
        for (const domain in this._properties) {
            const domainLabel = this._domains[domain];
            const fname = snakeCase(domainLabel);
            const args = [
                new Ast.ArgumentDef(
                    null, 
                    Ast.ArgDirection.OUT, 
                    'id',
                    new Type.Entity(`org.wikidata:${fname}`),
                    { nl: { canonical: { base: ['name'], passive_verb: ['named', 'called'] } } }
                )
            ];
            for (const [id, label] of Object.entries(this._properties[domain])) {
                const pname = snakeCase(label);
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
        const classDef = new Ast.ClassDef(null, 'org.wikidata', null, {
            imports, queries
        }, {
            nl: { name: 'WikidataQA', description: 'Question Answering over Wikidata'}
        });

        this._output.end(classDef.prettyprint());
        await waitFinish(this._output);
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
    const args = parser.parse_args();

    const generator = new ManifestGenerator(args);
    generator.generate();
}

main();