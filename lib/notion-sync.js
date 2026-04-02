const { Client } = require('@notionhq/client');

class NotionSync {
    constructor(settings, db) {
        this.settings = settings;
        this.db = db;
        this.client = null;
    }

    _getClient() {
        const token = this.settings.get('notionToken');
        if (!token) return null;
        if (!this.client) this.client = new Client({ auth: token });
        return this.client;
    }

    resetClient() {
        this.client = null;
    }

    // Convert 32-char hex to UUID format with dashes
    _toUuid(id) {
        const clean = (id || '').replace(/-/g, '');
        if (clean.length !== 32) return id;
        return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20)}`;
    }

    async ensureDatabase() {
        const client = this._getClient();
        if (!client) throw new Error('Notion APIトークンが設定されていません');

        const rawPageId = this.settings.get('notionPageId');
        if (!rawPageId) throw new Error('Notion 読書ログページIDが設定されていません');
        const pageId = this._toUuid(rawPageId);

        let dbId = this.settings.get('notionDatabaseId');

        // Check if existing database is still valid
        if (dbId) {
            try {
                await client.databases.retrieve({ database_id: dbId });
                return dbId;
            } catch (e) {
                // Database no longer exists, create a new one
                this.settings.set('notionDatabaseId', '');
                dbId = '';
            }
        }

        // Create database under the reading log page
        const response = await client.databases.create({
            parent: { page_id: pageId },
            title: [{ type: 'text', text: { content: '読書記録' } }],
            properties: {
                '書籍名': { title: {} },
                'ステータス': {
                    select: {
                        options: [
                            { name: '未読', color: 'default' },
                            { name: '読書中', color: 'blue' },
                            { name: '読了', color: 'green' },
                        ]
                    }
                },
                'ページ数': { number: {} },
                'タグ': { multi_select: {} },
                'お気に入り': { checkbox: {} },
                '追加日': { date: {} },
                '最終閲覧日': { date: {} },
            },
        });

        dbId = response.id;
        this.settings.set('notionDatabaseId', dbId);
        return dbId;
    }

    async syncBook(book) {
        if (!this.settings.get('notionSyncEnabled')) return;
        const client = this._getClient();
        if (!client) return;

        try {
            const dbId = await this.ensureDatabase();
            const existingPageId = await this._findBookPage(dbId, book.id);

            const statusMap = { unread: '未読', reading: '読書中', completed: '読了' };
            const properties = {
                '書籍名': { title: [{ text: { content: book.title } }] },
                'ステータス': { select: { name: statusMap[book.status] || '未読' } },
                'ページ数': { number: book.page_count || null },
                'タグ': { multi_select: (book.tags || []).map(t => ({ name: t.name })) },
                'お気に入り': { checkbox: !!book.favorite },
            };

            if (book.created_at) {
                properties['追加日'] = { date: { start: book.created_at.split(' ')[0] } };
            }
            if (book.last_opened_at) {
                properties['最終閲覧日'] = { date: { start: book.last_opened_at.split('T')[0] } };
            }

            if (existingPageId) {
                await client.pages.update({
                    page_id: existingPageId,
                    properties,
                });
            } else {
                // Create new page with paperstock_id in body for tracking
                await client.pages.create({
                    parent: { database_id: dbId },
                    properties,
                    children: [
                        {
                            object: 'block',
                            type: 'callout',
                            callout: {
                                icon: { emoji: '📗' },
                                rich_text: [{ text: { content: `Paperstock ID: ${book.id}` } }],
                            }
                        },
                        {
                            object: 'block',
                            type: 'heading_2',
                            heading_2: { rich_text: [{ text: { content: 'メモ' } }] }
                        },
                        {
                            object: 'block',
                            type: 'paragraph',
                            paragraph: { rich_text: [] }
                        },
                    ],
                });
            }
        } catch (e) {
            console.error('Notion sync failed:', e.message);
            throw e;
        }
    }

    async syncAllBooks() {
        if (!this.settings.get('notionSyncEnabled')) return { synced: 0, errors: 0 };
        const client = this._getClient();
        if (!client) throw new Error('Notion APIトークンが設定されていません');

        await this.ensureDatabase();
        const books = this.db.getAllBooks();
        let synced = 0, errors = 0;

        for (const book of books) {
            try {
                await this.syncBook(book);
                synced++;
            } catch (e) {
                errors++;
            }
        }

        return { synced, errors };
    }

    async _findBookPage(dbId, bookId) {
        const client = this._getClient();
        if (!client) return null;

        try {
            // Search for pages containing the Paperstock ID
            const response = await client.databases.query({
                database_id: dbId,
                page_size: 100,
            });

            for (const page of response.results) {
                // Check page content for Paperstock ID
                try {
                    const blocks = await client.blocks.children.list({ block_id: page.id, page_size: 5 });
                    for (const block of blocks.results) {
                        if (block.type === 'callout') {
                            const text = block.callout.rich_text.map(r => r.plain_text).join('');
                            if (text.includes(`Paperstock ID: ${bookId}`)) {
                                return page.id;
                            }
                        }
                    }
                } catch (e) { /* skip */ }
            }
        } catch (e) {
            console.error('Error searching Notion:', e.message);
        }

        return null;
    }

    async testConnection() {
        const client = this._getClient();
        if (!client) throw new Error('APIトークンが未設定です');

        const rawPageId = this.settings.get('notionPageId');
        if (!rawPageId) throw new Error('ページIDが未設定です');

        // Try to retrieve the page to verify access
        const page = await client.pages.retrieve({ page_id: this._toUuid(rawPageId) });
        return { success: true, title: page.properties?.title?.title?.[0]?.plain_text || 'OK' };
    }
}

module.exports = NotionSync;
