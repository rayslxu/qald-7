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

// number of times to try the ned process in case of failure
const MAX_TRY = 2;
const RETRY_WAIT = 500;

function sleep(ms : number) {
    // eslint-disable-next-line no-promise-executor-return
    return new Promise((res) => setTimeout(res, ms));
}

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

// run the linker in a streaming fashion, one example at a time
async function streamLink(linker : Linker, 
                          oracleLinker : OracleLinker, 
                          examples : Example[], 
                          options : { is_synthetic : boolean }) {
    let countFail = 0;
    let countTotal = 0;
    for (const ex of examples) {
        countTotal += 1;
        let tryCount = 0;
        while (tryCount < MAX_TRY) {
            try {
                const result = await linker.run(ex.id, ex.sentence, ex.thingtalk);
                const oracle = await oracleLinker.run(ex.id, ex.sentence, ex.thingtalk);
                let hasMissingEntity = false;
                for (const entity of oracle.entities) {
                    if (result.entities.some((e) => e.id === entity.id))
                        continue;
                    hasMissingEntity = true;
                    // if we are working on the synthetic set, add the correct entities into the list
                    if (options.is_synthetic)
                        result.entities.push(entity);
                }
                if (hasMissingEntity)
                    countFail += 1;
                ex.entities = [...new Set(result.entities)];
                ex.relation = [...new Set(result.relations)];
                break;
            } catch(e) {
                console.log(`NED for example ${ex.id} failed. Attempt No. ${tryCount+1}`);
                tryCount ++;
                if (tryCount === MAX_TRY)
                    console.warn(`NED for Example ${ex.id} failed after ${MAX_TRY} attempts.`);
                else 
                    await sleep(RETRY_WAIT);
            }
        }
    }
    console.log('Failed: ', countFail);
    console.log('Total: ', countTotal);
}

// run the linker in one batch
async function batchLink(linker : ReFinEDLinker, 
                         oracleLinker : OracleLinker, 
                         examples : Example[], 
                         options : { is_synthetic : boolean }) {
    await linker.runAll(examples);
    if (options.is_synthetic) {
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
            break;
        }
        console.log('Failed: ', countFail);
        console.log('Total: ', countTotal);
    }
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
        choices: ['falcon', 'oracle', 'azure', 'gpt3', 'refined'],
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
    let linker : Linker;
    if (args.module === 'falcon') 
        linker = new Falcon(wikidata, args);
    else if (args.module === 'oracle')
        linker = oracleLinker;
    else if (args.module === 'azure')
        linker = new AzureEntityLinker(wikidata, args);
    else if (args.module === 'gpt3')
        linker = new GPT3Linker(wikidata, args);
    else if (args.module === 'refined')
        linker = new ReFinEDLinker(wikidata);
    else
        throw new Error('Unknown NER module');

    const rephraser = new GPT3Rephraser('https://wikidata.openai.azure.com', wikidata);
    const columns = ['id', 'sentence', 'thingtalk'];
    const dataset = args.input.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
        .pipe(new StreamUtils.MapAccumulator());
    const data = await dataset.read(); 
    const examples = data.values();


    // run entity linking 
    if (linker instanceof ReFinEDLinker) 
        await batchLink(linker, oracleLinker, examples, args);
    else 
        await streamLink(linker, oracleLinker, examples, args);

    // output linker result
    for (const ex of examples) {
        const nedInfo = ['<e>'];
        shuffle(ex.entities);
        for (const entity of ex.entities) {
            nedInfo.push(entity.label);
            if (entity.domain)
                nedInfo.push('(', entity.domain, ')');
            nedInfo.push('[', entity.id, ']', ';');
        }
        for (const property of ex.relations)
            nedInfo.push(property.label, '[', property.id, ']', ';');
        nedInfo.push('</e>');
        const utterance = args.gpt3_rephrase && !args.is_synthetic ? 
            await rephraser.rephrase(ex.sentence, ex.entities.map((e : Entity) => e.id)) : ex.sentence;
        args.output.write(`${ex.id}\t${utterance + ' ' + nedInfo.join(' ')}\t${ex.thingtalk}\n`);   
    }
    StreamUtils.waitFinish(args.output);
}

if (require.main === module)
    main();