import * as argparse from 'argparse';
import fs from 'fs';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Divide a QALD training file in half"
    });
    parser.add_argument('input', {
        help: "the file to be divided"
    });
    parser.add_argument('--size', {
        required: false,
        help: "size of the second slice of the data",
        type: parseInt
    });

    const args = parser.parse_args();
    const data = JSON.parse(fs.readFileSync(args.input, { encoding: 'utf8' }));
    const length = data.questions.length;
    const size = args.size ? length - args.size : length/2;
    const a = {
        questions: data.questions.slice(0, size)
    };
    const b = {
        questions: data.questions.slice(size)
    };
    fs.writeFileSync('xaa', JSON.stringify(a, undefined, 2));
    fs.writeFileSync('xab', JSON.stringify(b, undefined, 2));
}

if (require.main === module)
    main();