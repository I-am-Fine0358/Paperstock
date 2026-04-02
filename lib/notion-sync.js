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

        if (dbId) {
            try {
                await client.databases.retrieve({ database_id: this._toUuid(dbId) });
                return this._toUuid(dbId);
            } catch (e) {
                this.settings.set('notionDatabaseId', '');
                dbId = '';
            }
        }

        // Create inline database under the reading log page
        const response = await client.databases.create({
            parent: { type: 'page_id', page_id: pageId },
            is_inline: true,
            title: [{ type: 'text', text: { content: '読書記録' } }],
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
            const existingPageId = await this._findBookPage(dbId, book.title);

            const statusMap = { unread: '未読', reading: '読書中', completed: '読了' };

            // Build properties - only use Title (always exists) + simple text via children
            const properties = {
                title: { title: [{ text: { content: book.title } }] },
            };

            const bodyBlocks = [
                {
                    object: 'block',
                    type: 'callout',
                    callout: {
                        icon: { type: 'emoji', emoji: '📗' },
                        rich_text: [{ type: 'text', text: { content: `Paperstock ID: ${book.id}` } }],
                    }
                },
                {
                    object: 'block',
                    type: 'table',
                    table: {
                        table_width: 2,
                        has_column_header: false,
                        has_row_header: true,
                        children: [
                            this._tableRow('ステータス', statusMap[book.status] || '未読'),
                            this._tableRow('ページ数', String(book.page_count || 0)),
                            this._tableRow('タグ', (book.tags || []).map(t => t.name).join(', ') || 'なし'),
                            this._tableRow('お気に入り', book.favorite ? '★' : '-'),
                            this._tableRow('追加日', book.created_at ? book.created_at.split(' ')[0] : '-'),
                            this._tableRow('最終閲覧日', book.last_opened_at ? book.last_opened_at.split('T')[0] : '-'),
                        ]
                    }
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: { rich_text: [{ type: 'text', text: { content: 'メモ' } }] }
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: { rich_text: [] }
                },
            ];

            if (existingPageId) {
                // Update: replace title and update content blocks
                await client.pages.update({
                    page_id: existingPageId,
                    properties,
                });
                // Delete old blocks and recreate
                try {
                    const oldBlocks = await client.blocks.children.list({ block_id: existingPageId, page_size: 20 });
                    for (const block of oldBlocks.results) {
                        // Only delete our managed blocks (callout, table), preserve user content
                        if (block.type === 'callout' || block.type === 'table') {
                            await client.blocks.delete({ block_id: block.id });
                        }
                    }
                    // Re-add info blocks at the top
                    await client.blocks.children.append({
                        block_id: existingPageId,
                        children: bodyBlocks.slice(0, 2), // callout + table only
                    });
                } catch (e) {
                    // If block update fails, just update the title
                }
            } else {
                await client.pages.create({
                    parent: { type: 'database_id', database_id: dbId },
                    properties,
                    children: bodyBlocks,
                });
            }
        } catch (e) {
            console.error('Notion sync failed:', e.message);
            throw e;
        }
    }

    _tableRow(label, value) {
        return {
            type: 'table_row',
            table_row: {
                cells: [
                    [{ type: 'text', text: { content: label } }],
                    [{ type: 'text', text: { content: value } }],
                ]
            }
        };
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
                console.error(`Sync error for "${book.title}":`, e.message);
                errors++;
            }
        }

        return { synced, errors };
    }

    async _findBookPage(dbId, title) {
        const client = this._getClient();
        if (!client) return null;

        try {
            const response = await client.databases.query({
                database_id: dbId,
                filter: {
                    property: 'title',
                    title: { equals: title },
                },
                page_size: 1,
            });

            if (response.results.length > 0) {
                return response.results[0].id;
            }
        } catch (e) {
            // Fallback: scan all pages
            try {
                const response = await client.databases.query({ database_id: dbId, page_size: 100 });
                for (const page of response.results) {
                    const pageTitle = page.properties?.title?.title?.[0]?.plain_text ||
                                     page.properties?.['書籍名']?.title?.[0]?.plain_text || '';
                    if (pageTitle === title) return page.id;
                }
            } catch (e2) { /* give up */ }
        }

        return null;
    }

    async testConnection() {
        const client = this._getClient();
        if (!client) throw new Error('APIトークンが未設定です');

        const rawPageId = this.settings.get('notionPageId');
        if (!rawPageId) throw new Error('ページIDが未設定です');

        const page = await client.pages.retrieve({ page_id: this._toUuid(rawPageId) });
        return { success: true, title: 'OK' };
    }
}

module.exports = NotionSync;
