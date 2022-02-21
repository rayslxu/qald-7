import assert from 'assert';
import * as argparse from 'argparse';
import fs from 'fs';
import Stream from 'stream';
import byline from 'byline';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { Ast } from 'thingtalk';
import { DatasetParser, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';
import { waitFinish } from './utils/misc';

interface PostProcessorOptions {
    tpClient : Tp.BaseClient;
    schemas : ThingTalk.SchemaRetriever;
}

class PostProcessor {
    private _tpClient : Tp.BaseClient;
    private _schemas : ThingTalk.SchemaRetriever;

    constructor(options : PostProcessorOptions) {
        this._tpClient = options.tpClient;
        this._schemas = options.schemas;
    }

    private _hasIdFilter(ast : Ast.BooleanExpression) : boolean {
        if (ast instanceof Ast.OrBooleanExpression)
            return ast.operands.every((op) => this._hasIdFilter(op));
        if (ast instanceof Ast.AndBooleanExpression)
            return false;
        if (ast instanceof Ast.NotBooleanExpression)
            return false;
        if (ast instanceof Ast.AtomBooleanExpression) {
            if (ast.name === 'id') {
                assert(ast.value instanceof Ast.Value.Entity);
                ast.value.type = 'org.wikidata:entity';
                return true;
            }
        } 
        if (ast instanceof Ast.ComparisonSubqueryBooleanExpression) {
            if (ast.lhs instanceof Ast.Value.VarRef && ast.lhs.name === 'id')
                return true;
        }
        return false;
    }

    private _postprocessBooleanExpression(ast : Ast.BooleanExpression) : Ast.BooleanExpression {
        if (ast instanceof Ast.AndBooleanExpression || ast instanceof Ast.OrBooleanExpression) 
            ast.operands = ast.operands.map((op) => this._postprocessBooleanExpression(op));
        else if (ast instanceof Ast.NotBooleanExpression) 
            ast.expr = this._postprocessBooleanExpression(ast.expr);
        else if (ast instanceof Ast.ComparisonSubqueryBooleanExpression) 
            ast.rhs = this._postprocessExpression(ast.rhs);
        else if (ast instanceof Ast.ExistentialSubqueryBooleanExpression)
            ast.subquery = this._postprocessExpression(ast.subquery);
        return ast;
    }

    private _postprocessExpression(ast : Ast.Expression) : Ast.Expression {
        if (ast instanceof Ast.ChainExpression) {
            ast.expressions = ast.expressions.map((ex) => this._postprocessExpression(ex));
        } else if (ast instanceof Ast.SortExpression || 
            ast instanceof Ast.IndexExpression ||
            ast instanceof Ast.ProjectionExpression) {
            ast.expression = this._postprocessExpression(ast.expression);
        } else if (ast instanceof Ast.BooleanQuestionExpression) {
            ast.expression = this._postprocessExpression(ast.expression);
            ast.booleanExpression = this._postprocessBooleanExpression(ast.booleanExpression);
        } else if (ast instanceof Ast.FilterExpression) {
            if (this._hasIdFilter(ast.filter)) {
                const invocation = (ast.expression as Ast.InvocationExpression).invocation;
                invocation.channel = 'entity';
            }
        }
        return ast;
    }

    async postprocess(thingtalk : string, preprocessedUtterance : string) : Promise<string[]> {
        const entities = EntityUtils.makeDummyEntities(preprocessedUtterance);
        const program = await ThingTalkUtils.parsePrediction(thingtalk.split(' '), entities, {
            timezone : undefined,
            thingpediaClient: this._tpClient,
            schemaRetriever : this._schemas
        });
        // skip program that does not type check. 
        // TODO: fix typechecking
        if (!program)
            return thingtalk.split(' ');
        assert(program instanceof Ast.Program);
        const postprocessed : Ast.ExpressionStatement[] = [];
        for (const statement of program.statements) {
            assert(statement instanceof Ast.ExpressionStatement);
            postprocessed.push(new Ast.ExpressionStatement(null, this._postprocessExpression(statement.expression)));
        }
        program.statements = postprocessed;
        return ThingTalkUtils.serializePrediction(
            program, 
            preprocessedUtterance, 
            entities,
            { locale: 'en', timezone: undefined, includeEntityValue :true }
        );
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Post process generated data"
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: undefined,
        help: `Timezone to use to interpret dates and times (defaults to the current timezone).`
    });
    parser.add_argument('--thingpedia', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });

    const args = parser.parse_args();
    const tpClient = new Tp.FileClient(args);
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null);
    const processor = new PostProcessor({ tpClient, schemas });

    args.input.setEncoding('utf8').pipe(byline())
        .pipe(new DatasetParser({ contextual: false, preserveId: true }))
        .pipe(new Stream.Transform({
            objectMode: true,

            async transform(ex, encoding, callback) {
                try {
                    const postprocessed = await processor.postprocess(ex.target_code, ex.preprocessed);
                    ex.target_code = postprocessed.join(' ');
                    callback(null, ex);
                } catch(e) {
                    callback();
                }
            },

            flush(callback) {
                process.nextTick(callback);
            }
        }))
        .pipe(new DatasetStringifier())
        .pipe(args.output);
    waitFinish(args.output);
}

if (require.main === module)
    main();