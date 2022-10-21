import fs from 'fs';
import * as argparse from 'argparse';
import csvparse from 'csv-parse';
import { StreamUtils } from 'genie-toolkit';
import { Linker } from './base';
import { Falcon } from './falcon';

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
        choices: ['falcon'],
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--bootleg', {
        required: false,
        default: 'bootleg.sqlite'
    });

    const args = parser.parse_args();

    let linker : Linker;
    if (args.module === 'falcon') 
        linker = new Falcon(args);
    else 
        throw new Error('Unknown NER module');

    const columns = ['id', 'sentence', 'thingtalk'];
    const dataset = args.input.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const data = await dataset.read(); 
    for (const ex of data.values()) {
        const nedInfo = [];
        const result = await linker.run(ex.sentence);
        for (const entity of result.entities) 
            nedInfo.push(entity.label, '(', entity.domain, ')', '[', entity.id, ']', ';');
        for (const property of result.relations)
            nedInfo.push(property.label, '[', property.id, ']', ';');
        args.output.write(`${ex.id}\t${ex.sentence + ' <e> ' + nedInfo.join(' ') + ' </e>'}\t${ex.thingtalk}\n`);
    }
    StreamUtils.waitEnd(dataset);
    StreamUtils.waitFinish(args.output);
}

if (require.main === module)
    main();