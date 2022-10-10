import * as argparse from 'argparse';
import fs from 'fs';

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

    const args = parser.parse_args();
    const raw = fs.readFileSync(args.bootleg_output, { encoding: 'utf8' });
    const bootleg = [];
    for (const line of raw.trim().split('\n'))
        bootleg.push(JSON.parse(line));


    let countMissing = 0;
    let countMisranked = 0;
    const debug = fs.readFileSync(args.debug_file, { encoding : 'utf-8' });
    for (const row of debug.trim().split('\n')) {
        const [id, , , gold, ] = row.split('\t');
        const bootlegQIDs : string[] = bootleg[parseInt(id) - 1].cands.flat();
        const goldQIDs : RegExpMatchArray|null = gold.match(/Q[0-9]+/g);
        if (!goldQIDs)
            continue;
        for (const qid of goldQIDs) {
            if (!bootlegQIDs.includes(qid)) {
                countMissing +=1;
                break;
            } else if (!bootlegQIDs.slice(0, 2).includes(qid)) {
                countMisranked += 1;
                break;
            }
        }
    }
    console.log(countMissing);
    console.log(countMisranked);
}

if (require.main === module)
    main();