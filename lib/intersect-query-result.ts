import * as argparse from 'argparse';
import fs from 'fs';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Calculate the intersection of two SPARQL query result, useful when the combined one results in timeout"
    });
    parser.add_argument('--input', {
        nargs: '+',
        help: "path to input files"
    });

    const args = parser.parse_args();
    const entitiesByFile : string[][] = [];
    for (const f of args.input) {
        const data = JSON.parse(fs.readFileSync(f, { encoding: 'utf8' }));
        const entities = data.map((d : Record<string, string>) => Object.values(d)[0]);
        entitiesByFile.push(entities);
    }
    const intersection = entitiesByFile.reduce((a, b) => a.filter((c : string) => b.includes(c)));
    const result = {
        head: { vars: ['x'] },
        results: {
            bindings : intersection.map((d) => {
                return { x: { type: "uri", value: d } };
            })
        }
    };
    console.log(intersection.length);
    console.log(JSON.stringify(result, undefined, 2));

}

if (require.main === module)
    main();