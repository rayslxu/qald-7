import fs from 'fs';
import * as argparse from 'argparse';
import csvparse from 'csv-parse';
import { StreamUtils } from 'genie-toolkit';
import { Linker } from './base';
import { Falcon } from './falcon';
import { OracleLinker } from './oracle';
import { AzureEntityLinker } from './azure';
import { GPT3Rephraser } from '../gpt3/rephraser';
import { GPT3Linker } from './gpt3';
import WikidataUtils from '../utils/wikidata';
import { ReFinEDLinker } from './refined';
import { Entity, Example } from './base';

// in-place shuffle an array
function shuffle(array : any[]) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

export {
    Linker,
    Falcon,
    AzureEntityLinker
};

// run the linker in one batch
async function link(linkers : Linker[], 
                    oracleLinker : OracleLinker, 
                    examples : Example[], 
                    options : { is_synthetic : boolean }) {
    for (const linker of linkers)
        await linker.saferunAll(examples);

    let countFail = 0;
    let countTotal = 0; 
    for (const ex of examples) {
        countTotal += 1;
        const oracle = await oracleLinker.run(ex.id, ex.sentence, ex.thingtalk);
        let hasMissingEntity = false;
        for (const entity of oracle.entities) {
            if (ex.entities!.some((e) => e.id === entity.id))
                continue;
            hasMissingEntity = true;
            // if we are working on the synthetic set, add the correct entities into the list
            if (options.is_synthetic)
                ex.entities!.push(entity);
        }
        if (hasMissingEntity)
            countFail += 1;
    }
    console.log('Failed: ', countFail);
    console.log('Total: ', countTotal);
}

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
        choices: ['falcon', 'oracle', 'azure', 'gpt3', 'refined', 'ensemble'],
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
    parser.add_argument(`--gpt3-rephrase`, {
        default: false,
        action: 'store_true',
        help: 'Enable GPT3 rephrase of the original utterance'
    });
    parser.add_argument(`--is-synthetic`, {
        default: false,
        action: 'store_true',
        help: 'If we are handling a synthetic dataset, if so, we want to make sure gold entities are always presented'
    });

    const args = parser.parse_args();
    if (!args.ner_cache)
        args.ner_cache = args.module + '.sqlite';

    if ((args.is_synthetic || args.input.path.includes('synthetic') || args.input.path.includes('everything')) && args.module === 'gpt3')
        throw new Error('Trying to run GPT-3 NED over the synthetic dataset. For cost reason, this is forbidden.');
    
    const wikidata = new WikidataUtils(args.wikidata_cache, args.bootleg);

    const oracleLinker = new OracleLinker(wikidata);
    const linkers : Linker[] = [];
    if (args.module === 'oracle')
        linkers.push(oracleLinker);
    if (args.module === 'falcon' || args.module === 'ensemble') 
        linkers.push(new Falcon(wikidata, args));
    if (args.module === 'azure' || args.module === 'ensemble')
        linkers.push(new AzureEntityLinker(wikidata, args));
    if (args.module === 'gpt3' || args.module === 'ensemble')
        linkers.push(new GPT3Linker(wikidata, args));
    if (args.module === 'refined' || args.module === 'ensemble')
        linkers.push(new ReFinEDLinker());
    
    if (linkers.length === 0)
        throw new Error('Unknown NER module');

    const rephraser = new GPT3Rephraser('https://wikidata.openai.azure.com', wikidata);
    const columns = ['id', 'sentence', 'thingtalk'];
    const dataset = args.input.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const data = await dataset.read(); 
    const examples = Array.from(data.values()) as Example[];


    // run entity linking 
    await link(linkers, oracleLinker, examples, args);

    // output linker result
    for (const ex of examples) {
        const nedInfo = ['<e>'];
        shuffle(ex.entities!);
        for (const entity of ex.entities!) {
            nedInfo.push(entity.label);
            if (entity.domain)
                nedInfo.push('(', entity.domain, ')');
            nedInfo.push('[', entity.id, ']', ';');
        }
        for (const property of ex.relation!)
            nedInfo.push(property.label, '[', property.id, ']', ';');
        nedInfo.push('</e>');
        const utterance = args.gpt3_rephrase && !args.is_synthetic ? 
            await rephraser.rephrase(ex.sentence, ex.entities!.map((e : Entity) => e.id)) : ex.sentence;
        args.output.write(`${ex.id}\t${utterance + ' ' + nedInfo.join(' ')}\t${ex.thingtalk}\n`);   
    }
    StreamUtils.waitFinish(args.output);
}

if (require.main === module)
    main();