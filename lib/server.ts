import * as argparse from 'argparse';
import fs from 'fs';
import express from 'express';
import fetch from 'node-fetch';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { I18n } from 'genie-toolkit';
import { Linker, AzureEntityLinker, Falcon } from './ner';
import WikidataUtils from './utils/wikidata';
import { ThingTalkToSPARQLConverter } from './converter';
import { TP_DEVICE_NAME } from '../lib/utils/wikidata';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help: true,
        description: "Expose a Genie-compatible NLP API over HTTP."
    });
    parser.add_argument('-p', '--port', {
        required: false,
        help: "HTTP port to listen on",
        default: 3000,
    });
    parser.add_argument('--nlu-server', {
        required: false,
        help: "Endpoint for the NLU server",
        default: 'http://127.0.0.1:8400/en-US/query'
    });
    parser.add_argument('--manifest', {
        required: false,
        default: './manifest.tt',
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('--domains', {
        required: false,
        default: './domain.json',
        help: 'Path to the JSON file with domain information'
    });
    parser.add_argument('--ned', {
        required: false,
        choices: ['azure', 'falcon']
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

    const args = parser.parse_args();
    const tpClient = new Tp.FileClient({ thingpedia: args.manifest, locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const classDef = await schemas.getFullMeta(TP_DEVICE_NAME);
    const domains = JSON.parse(fs.readFileSync(args.domains, { encoding: 'utf8' })).data;
    const tokenizer = I18n.get('en-US').getTokenizer();
    const converter = new ThingTalkToSPARQLConverter(classDef, domains, {
        locale: 'en-US',
        timezone: 'utc',
        cache: args.wikidata_cache,
        save_cache: true,
        bootleg: args.bootleg,
        human_readable_instance_of: false
    });
    const wikidata = new WikidataUtils(args.wikidata_cache, args.bootleg);
    let entityLinker : Linker;
    if (args.ned) {
        if (args.ned === 'azure')
            entityLinker = new AzureEntityLinker(wikidata, args);
        else
            entityLinker = new Falcon(wikidata, args);
    }

    const app = express();
    app.get('/query', async (req, res) => {
        console.log('Query received: ' + req.query.q);
        const utterance = req.query.q as string;
        const entities = [];
        const entityInfo = [];
        if (args.ned) {
            entities.push(...(await entityLinker.run((new Date()).toISOString(), utterance)).entities);
            entityInfo.push('<e>');
            for (const entity of entities) {
                entityInfo.push(entity.label);
                if (entity.domain)
                    entityInfo.push('(', entity.domain, ')');
                entityInfo.push('[', entity.id, ']', ';');
            }
            entityInfo.push('</e>');
        }
        const tokenized = tokenizer.tokenize(utterance).rawTokens.join(' ');
        const processed = tokenized + ' ' + entityInfo.join(' ');
        const response = await fetch(args.nlu_server, {
            method: 'post',
            body: JSON.stringify({ q: processed, tokenized: true }),
            headers: { 'Content-Type': 'application/json' }
        });
        const result = await response.json();
        const candidates = result.candidates;
        const thingtalk = candidates && candidates.length > 0 ? result.candidates[0].code.join(' ') : undefined;
        try {
            const sparql = await converter.convert(tokenized, thingtalk);
            console.log('SPARQL:', sparql);
            const answers = await wikidata.query(sparql);
            res.json({
                utterance,
                entities,
                thingtalk,
                sparql,
                answers
            });
        } catch(e : any) {
            res.json({
                utterance,
                entities,
                thingtalk,
                error: e.message
            });
        }
        
    });

    app.listen(args.port, () => {
        console.log('Server started');
    });
}


main();