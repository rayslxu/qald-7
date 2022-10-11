import * as argparse from 'argparse';
import fs from 'fs';
import WikidataUtils from './utils/wikidata';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Check bootleg outputs"
    });
    parser.add_argument('--bootleg-output', {
        help: "the file containing the bootleg output"
    });
    parser.add_argument('--debug-file', {
        help: ".debug file produced by a model evaluation"
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });

    const args = parser.parse_args();
    const raw = fs.readFileSync(args.bootleg_output, { encoding: 'utf8' });
    const bootleg = [];
    for (const line of raw.trim().split('\n'))
        bootleg.push(JSON.parse(line));

    const wiki = new WikidataUtils(args.cache, args.bootleg_db);
    let countMissing = 0;
    let countMisranked = 0;
    const debug = fs.readFileSync(args.debug_file, { encoding : 'utf-8' });
    for (const row of debug.trim().split('\n')) {
        const [id, , utterance, gold, ] = row.split('\t');
        const bootlegQIDs : string[] = bootleg[parseInt(id) - 51].cands.flat().filter((cand : string) => cand !== "-1");
        const goldQIDs : RegExpMatchArray|null = gold.match(/Q[0-9]+/g);
        if (!goldQIDs)
            continue;
        console.log(id, utterance);
        const predictedLabel = [];
        for (const qid of bootlegQIDs) 
            predictedLabel.push(`${qid} (${await wiki.getLabel(qid)})`);
        console.log('Predicted: ', predictedLabel);
        for (const qid of goldQIDs) {
            const qlabel = await wiki.getLabel(qid);
            if (!bootlegQIDs.includes(qid)) {
                countMissing +=1; 
                console.log(`${qid} (${qlabel}) missing`);
                break;
            } else if (!bootlegQIDs.slice(0, 2).includes(qid)) {
                countMisranked += 1;
                console.log(`${qid} (${qlabel}) ranked low`);
                break;
            }
        }
    }
    console.log(countMissing);
    console.log(countMisranked);
}

if (require.main === module)
    main();