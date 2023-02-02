import * as Tp from 'thingpedia';

export default class AzureGPT3Wrapper {
    private _url : string;

    constructor(baseUrl : string) {
        this._url = `${baseUrl}/openai/deployments/text/completions?api-version=2022-12-01`;
    }

    async complete(prompt : string) : Promise<string|null> {
        const raw = await Tp.Helpers.Http.post(this._url, JSON.stringify({ prompt }), {
            dataContentType: 'application/json',
            extraHeaders: { 'api-key': process.env.OPENAI_API_KEY as string }
        });
        const res = JSON.parse(raw);
        if (res.choices.length > 0)
            return res.choices[0].text.trim();
        return null;
    }
}