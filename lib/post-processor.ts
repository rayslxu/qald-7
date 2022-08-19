import * as argparse from 'argparse';
import fs from 'fs';
import Stream from 'stream';
import byline from 'byline';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { Ast } from 'thingtalk';
import { DatasetParser, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';
import { waitFinish } from './utils/misc';
import { instanceOfFilter } from './utils/thingtalk';
import WikidataUtils, { TP_DEVICE_NAME } from './utils/wikidata';

function hasFilter(ast : Ast.BooleanExpression, property : string) : boolean {
    if (ast instanceof Ast.OrBooleanExpression)
        return ast.operands.every((op) => hasFilter(op, property));
    if (ast instanceof Ast.AndBooleanExpression)
        return false;
    if (ast instanceof Ast.NotBooleanExpression)
        return false;
    if (ast instanceof Ast.AtomBooleanExpression) {
        if (ast.name === property) 
            return true;
    } 
    if (ast instanceof Ast.ComparisonSubqueryBooleanExpression) {
        if (ast.lhs instanceof Ast.Value.VarRef && ast.lhs.name === property)
            return true;
    }
    return false;
}

class NormalizerVisitor extends Ast.NodeVisitor {
    private _class : Ast.ClassDef;
    private _normalizeDomains : 'always'|'id-filtered-only'|'never';
    private _normalizeEntityTypes : boolean;
    private _humanReadableInstanceOf : boolean;
    entities : Set<Ast.EntityValue>;

    constructor(
        klass : Ast.ClassDef,
        options : { 
        normalizeDomains : 'always'|'id-filtered-only'|'never', 
        normalizeEntityTypes : boolean,
        humanReadableInstanceOf : boolean
    }) {
        super();
        this._class = klass;
        this._normalizeDomains = options.normalizeDomains;
        this._normalizeEntityTypes = options.normalizeEntityTypes;
        this._humanReadableInstanceOf = options.humanReadableInstanceOf;
        this.entities = new Set();
    }

    private _instanceOfFilter(invocation : Ast.InvocationExpression) : Ast.BooleanExpression {
        const domain = invocation.invocation.channel;
        const functionDef = this._class.getFunction('query', domain)!;
        const qid = (functionDef.getImplementationAnnotation('wikidata_subject')! as string[])[0];
        const display = functionDef.canonical![0];
        return instanceOfFilter(qid, display, `${TP_DEVICE_NAME}:entity`, this._humanReadableInstanceOf);
    }

    private _addInstanceOfFilter(invocation : Ast.InvocationExpression) : Ast.Expression {
        if (invocation.invocation.channel === 'entity')
            return invocation;
        const filter = this._instanceOfFilter(invocation);
        return new Ast.FilterExpression(null, invocation, filter, null);
    }

    visitInvocationExpression(invocation : Ast.InvocationExpression) {
        if (this._normalizeDomains === 'always') 
            invocation.invocation.channel = 'entity';
        return true;
    }

    visitAggregationExpression(node : ThingTalk.Ast.AggregationExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitBooleanQuestionExpression(node : ThingTalk.Ast.BooleanQuestionExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitJoinExpression(node : ThingTalk.Ast.JoinExpression) : boolean {
        if (this._normalizeDomains === 'always') {
            if (node.lhs instanceof Ast.InvocationExpression) 
                node.lhs = this._addInstanceOfFilter(node.lhs);
            if (node.rhs instanceof Ast.InvocationExpression) 
                node.rhs = this._addInstanceOfFilter(node.rhs);
        }
        return true;
    }

    visitIndexExpression(node : ThingTalk.Ast.IndexExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitSortExpression(node : ThingTalk.Ast.SortExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitSliceExpression(node : ThingTalk.Ast.SliceExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitProjectionExpression2(node : ThingTalk.Ast.ProjectionExpression2) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitFilterExpression(node : Ast.FilterExpression) : boolean {
        if (this._normalizeDomains === 'id-filtered-only' && hasFilter(node.filter, 'id')) {
            const invocation = (node.expression as Ast.InvocationExpression).invocation;
            invocation.channel = 'entity';
        } else if (this._normalizeDomains === 'always') {
            const invocationExpression = node.expression as Ast.InvocationExpression;
            if (invocationExpression.invocation.channel === 'entity')
                return true;
            if (!hasFilter(node.filter, 'id') && !hasFilter(node.filter, 'instance_of')) {
                node.filter = new Ast.AndBooleanExpression(
                    null, 
                    [this._instanceOfFilter(invocationExpression), node.filter]
                );
            }
            invocationExpression.invocation.channel = 'entity';
        }
        return true;
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        if (node.name === 'instance_of' && node.value instanceof Ast.EntityValue) {
            node.value.type = `${TP_DEVICE_NAME}:domain`;
            return false;
        }
        return true;
    }

    visitEntityValue(value : Ast.EntityValue) : boolean {
        if (this._normalizeEntityTypes)
            value.type = `${TP_DEVICE_NAME}:entity`;
        else if (this._normalizeDomains !== 'never' && !value.type.startsWith(`${TP_DEVICE_NAME}:p_`)) 
            value.type = `${TP_DEVICE_NAME}:entity`;
            
        this.entities.add(value);
        return true;
    }
}

interface PostProcessorOptions {
    tpClient : Tp.BaseClient;
    schemas : ThingTalk.SchemaRetriever;
    wikidata : WikidataUtils;
    class : Ast.ClassDef;
    normalizeDomains : 'always'|'id-filtered-only'|'never';
    normalizeEntityTypes : boolean; 
    includeEntityValue : boolean;
    excludeEntityDisplay : boolean;
    humanReadableInstanceOf : boolean;
    oracleNED : boolean;
}

export class PostProcessor {
    private _tpClient : Tp.BaseClient;
    private _schemas : ThingTalk.SchemaRetriever;
    private _wikidata : WikidataUtils;
    private _normalizer : NormalizerVisitor;
    private _includeEntityValue : boolean;
    private _excludeEntityDisplay : boolean;
    private _oracleNED : boolean;

    constructor(options : PostProcessorOptions) {
        this._tpClient = options.tpClient;
        this._schemas = options.schemas;
        this._wikidata = options.wikidata;
        this._normalizer = new NormalizerVisitor(options.class, options);
        this._includeEntityValue = options.includeEntityValue;
        this._excludeEntityDisplay = options.excludeEntityDisplay;
        this._oracleNED = options.oracleNED;
    }

    async postprocess(thingtalk : string, preprocessedUtterance : string) : Promise<[string[], string]> {
        const entities = EntityUtils.makeDummyEntities(preprocessedUtterance);
        const program = await ThingTalkUtils.parsePrediction(thingtalk.split(' '), entities, {
            timezone : 'utc',
            thingpediaClient: this._tpClient,
            schemaRetriever : this._schemas
        });
        // skip program that does not type check. 
        // TODO: fix typechecking
        if (!program)
            throw new Error('Typecheck failed: ' + thingtalk);
        program.visit(this._normalizer);
        const serialized = ThingTalkUtils.serializePrediction(
            program.optimize(), 
            preprocessedUtterance, 
            entities,
            { 
                locale: 'en', 
                timezone: 'utc', 
                includeEntityValue: this._includeEntityValue, 
                excludeEntityDisplay: this._excludeEntityDisplay 
            }
        );
        if (this._oracleNED) {
            const oracleNED_suffix = [];
            for (const entity of this._normalizer.entities) {
                const qid = entity.value!;
                const type = (await this._wikidata.getDomain(qid))!;
                const typeLabel = (await this._wikidata.getLabel(type))!;
                oracleNED_suffix.push('<e>', qid, typeLabel);
                if (entity.display)
                    oracleNED_suffix.push(entity.display);
            }
            return [serialized, ' ' + oracleNED_suffix.join(' ')];
        }
        return [serialized, ''];
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
        default: 'utc',
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
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });
    parser.add_argument('--normalize-domains', {
        choices: ['always','id-filtered-only','never'],
        default: 'id-filtered-only'
    });
    parser.add_argument('--normalize-entity-types', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--include-entity-value', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--exclude-entity-display', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--oracle-ned', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--human-readable-instance-of', {
        action: 'store_true',
        help: 'Use human readable string for instance_of instead of QID.',
        default: false
    });

    const args = parser.parse_args();
    const tpClient = new Tp.FileClient(args);
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null);
    const wikidata = new WikidataUtils(args.cache, args.bootleg_db);
    const processor = new PostProcessor({ 
        tpClient, 
        schemas, 
        wikidata,
        class: await schemas.getFullMeta(TP_DEVICE_NAME),
        normalizeDomains: args.normalize_domains,
        normalizeEntityTypes: args.normalize_entity_types,
        includeEntityValue: args.include_entity_value,
        excludeEntityDisplay: args.exclude_entity_display,
        humanReadableInstanceOf: args.human_readable_instance_of,
        oracleNED: args.oracle_ned
    });

    args.input.setEncoding('utf8').pipe(byline())
        .pipe(new DatasetParser({ contextual: false, preserveId: true }))
        .pipe(new Stream.Transform({
            objectMode: true,

            async transform(ex, encoding, callback) {
                try {
                    const [postprocessed, suffix] = await processor.postprocess(ex.target_code, ex.preprocessed);
                    ex.target_code = postprocessed.join(' ');
                    ex.preprocessed = ex.preprocessed + suffix;
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