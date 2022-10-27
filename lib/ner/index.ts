import fs from 'fs';
import * as argparse from 'argparse';
import csvparse from 'csv-parse';
import { StreamUtils } from 'genie-toolkit';
import { Linker } from './base';
import { Falcon } from './falcon';
import { OracleLinker } from './oracle';
import { AzureEntityLinker } from './azure';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Run NER on a dataset"
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

    const args = parser.parse_args();
    if (!args.ner_cache)
        args.ner_cache = args.module + '.sqlite';

    let linker : Linker;
    if (args.module === 'falcon') 
        linker = new Falcon(args);
    else if (args.module === 'oracle')
        linker = new OracleLinker(args);
    else if (args.module === 'azure')
        linker = new AzureEntityLinker(args);
    else
        throw new Error('Unknown NER module');

    const columns = ['id', 'sentence', 'thingtalk'];
    const dataset = args.input.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const data = await dataset.read(); 
    let countFail = 0;
    let countTotal = 0;
    for (const ex of data.values()) {
        countTotal += 1;
        const nedInfo = ['<e>'];
        const result = await linker.run(ex.sentence, ex.thingtalk);
        const oracle = ex.thingtalk.match(/Q[0-9]+/g);
        for (const qid of oracle ?? []) {
            if (result.entities.some((e) => e.id === qid))
                continue;
            countFail += 1;
            break;
        }

        for (const entity of result.entities) {
            nedInfo.push(entity.label);
            if (entity.domain)
                nedInfo.push('(', entity.domain, ')');
            nedInfo.push('[', entity.id, ']', ';');
        }
        for (const property of result.relations)
            nedInfo.push(property.label, '[', property.id, ']', ';');
        nedInfo.push('</e>');
        args.output.write(`${ex.id}\t${ex.sentence + ' ' + nedInfo.join(' ')}\t${ex.thingtalk}\n`);
    }
    console.log('Failure rate: ', countFail/countTotal);
    StreamUtils.waitEnd(dataset);
    StreamUtils.waitFinish(args.output);
}

if (require.main === module)
    main();