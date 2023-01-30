import fs from 'fs';
import * as argparse from 'argparse';
import csvparse from 'csv-parse';
import { StreamUtils } from 'genie-toolkit';
import { Linker } from '../ner/base';
import { Falcon } from '../ner/falcon';
import { OracleLinker } from '../ner/oracle';
import { AzureEntityLinker } from '../ner/azure';
import WikidataUtils from '../utils/wikidata';
import { cleanName } from '../utils/misc';

const PROMPT_SEP_TOKENS = '#';
const PROMPT_END_TOKENS = '\n#\n\n';
const RESPONSE_END_TOKENS = '\n';

class SchemaRetriever {
    private _wikidata : WikidataUtils;

    constructor(wikidata : WikidataUtils) {
        this._wikidata = wikidata;
    }

    async retrieveOne(entity : string) {
        const properties = await this._wikidata.getConnectedProperty(entity);
        const ttProperties = [];
        for (const property of properties) {
            const label = await this._wikidata.getLabel(property);
            ttProperties.push(cleanName(label!));
        }
        return ttProperties;
    }

    async retrieve(entities : string[]) {
        const properties = [];
        for (const entity of entities) 
            properties.push(...(await this.retrieveOne(entity)));
        return properties;
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Generate prompt for GPT-3"
    });
    parser.add_argument('-i', '--input', {
        help: "the file to be processed",
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        help: "the file to write the processed data",
        type: fs.createWriteStream
    });
    parser.add_argument('--module', {
        required: false,
        default: 'falcon',
        help: "the NER module to load",
        choices: ['falcon', 'oracle', 'azure'],
    });
    parser.add_argument('--schema', {
        required: false,
        default: false,
        action: 'store_true',
        help: "Include schema based on NER"
    });
    parser.add_argument('--ner-cache', {
        required: false,
        help: `the path to the cache db, default to the module name if absent`
    });
    parser.add_argument('--wikidata-cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--bootleg', {
        required: false,
        default: 'bootleg.sqlite'
    });
    parser.add_argument('--raw-data', {
        required: false,
        help: 'path to the original data file to retrieve case sensitive utterance'
    });

    const args = parser.parse_args();
    if (!args.ner_cache)
        args.ner_cache = args.module + '.sqlite';
    const wikidata = new WikidataUtils(args.wikidata_cache, args.bootleg);

    let linker : Linker;
    if (args.module === 'falcon') 
        linker = new Falcon(wikidata, args);
    else if (args.module === 'oracle')
        linker = new OracleLinker(args);
    else if (args.module === 'azure')
        linker = new AzureEntityLinker(wikidata, args);
    else
        throw new Error('Unknown NER module');

    const schemaRetriever = new SchemaRetriever(args);

    const columns = ['id', 'utterance', 'thingtalk'];
    const dataset = args.input.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const data = await dataset.read(); 
    for (const ex of data.values()) {
        const prompt = [];
        // add question into prompt
        prompt.push('Question: ' + ex.utterance);

        // add entities into prompt
        prompt.push(PROMPT_SEP_TOKENS);
        prompt.push('Entities:');
        const result = await linker.run(ex.id, ex.utterance, ex.thingtalk);
        for (const entity of result.entities) {
            let entityInfo = entity.label;
            if (entity.domain)
                entityInfo += ` ( ${entity.domain} )`;
            entityInfo += `: ${entity.id}`;
            prompt.push(entityInfo);
        }
        if (result.relations.length > 0) 
            prompt.push(PROMPT_SEP_TOKENS);
        for (const property of result.relations)
            prompt.push(`${property.label}: property.id`);

        // add relations into prompt
        if (args.schema) {
            prompt.push(PROMPT_SEP_TOKENS);
            prompt.push('Properties:');
            const properties = await schemaRetriever.retrieve(result.entities.map((e) => e.id));
            prompt.push(properties.join(', '));
        }

        prompt.push(PROMPT_END_TOKENS);
        args.output.write(JSON.stringify({
            id : ex.id,
            utterance: ex.utterance,
            prompt: prompt.join('\n'),
            completion: ex.thingtalk + RESPONSE_END_TOKENS
        }) + '\n');
    }
    StreamUtils.waitEnd(dataset);
    StreamUtils.waitFinish(args.output);
}

if (require.main === module)
    main();