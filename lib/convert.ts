
import assert from 'assert';
import { Ast } from 'thingtalk';
import { Parser as SparqlParser } from 'sparqljs';
import { questions } from '../data/test.json';
import * as argparse from 'argparse';

function process(options : any) {
    const parser = new SparqlParser();
    for (const example of questions) {
        assert(example.question.length === 1);
        const question = example.question[0].string;
        const sparql = example.query.sparql;
        console.log(`${question}\t${sparql}`);
        const parsed = parser.parse(sparql);
        toThingTalk(parsed);

    }
}

function toThingTalk(sparql : Record<string, any>) : Ast.Node {
    throw new Error('Not supported by ThingTalk');
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "A tool to convert QALD-7 SPARQL to ThingTalk"
    });
    const args = parser.parse_args();
    process(args);
}

main();