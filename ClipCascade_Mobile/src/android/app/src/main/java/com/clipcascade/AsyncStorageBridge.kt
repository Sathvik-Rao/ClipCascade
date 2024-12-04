package com.clipcascade

import android.content.Context
import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.util.Log

/* 
 * depends on: @react-native-async-storage/async-storage
 * https://github.com/invertase/react-native-async-storage/blob/master/android/src/main/java/com/reactnativecommunity/asyncstorage/ReactDatabaseSupplier.java
 */ 
import com.reactnativecommunity.asyncstorage.ReactDatabaseSupplier


class AsyncStorageBridge(private val context: Context) {
    companion object {
        private const val TABLE_CATALYST = "catalystLocalStorage";
        private const val KEY_COLUMN = "key";
        private const val VALUE_COLUMN = "value";
        private const val TAG = "AsyncStorageBridge"
    }

    private var db: SQLiteDatabase? = null

    init {
        connect()
    }

    // Connect to the database
    fun connect()
    {
        try {
            db = ReactDatabaseSupplier.getInstance(context).get()
        } catch (e: Exception) {
            Log.e(TAG, "Error connecting to database", e)
        }
    }

    // Disconnect from the database
    fun disconnect() {
        try {
            db?.close()
            db = null
        } catch (e: Exception) {
            Log.e(TAG, "Error disconnecting from database", e)
        }
    }

    fun checkConnection(): Boolean  {
        if (db == null || !db!!.isOpen) {
            Log.e(TAG, "Database is not connected.")
            return false
        }
        return true
    }

    // Method to get a value by key
    fun getValue(key: String): String? {
        var cursor: Cursor? = null
        try {
            cursor = db?.query(
                TABLE_CATALYST,         // Table name
                arrayOf(VALUE_COLUMN),  // Columns
                "$KEY_COLUMN = ?",      // Selection (WHERE clause)
                arrayOf(key),           // Selection arguments
                null,                   // Group by
                null,                   // Having
                null                    // Order
            ) ?: return null

            var value: String? = null
            if (cursor.moveToFirst()) {
                value = cursor.getString(cursor.getColumnIndexOrThrow(VALUE_COLUMN))
                value = value.replace("^\"|\"$".toRegex(), "") // Remove leading and trailing double quotes 
            }
            return value
        } catch (e: Exception) {
            Log.e(TAG, "Error retrieving value for key $key", e)
            return null
        } finally {
            cursor?.close()
        }
    }

    // Method to set a key-value pair
    @Synchronized
    fun setValue(key: String, value: String): Boolean {
        try {
            val values = ContentValues().apply {
                put(KEY_COLUMN, key)
                put(VALUE_COLUMN, "\"$value\"")
            }
            db?.insertWithOnConflict(
                TABLE_CATALYST,                   // Table name
                null,                             //NullColumnHack 
                values,                           // ContentValues containing the key-value pair
                SQLiteDatabase.CONFLICT_REPLACE   // Replace if key already exists
            )
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Error setting value for key $key", e)
            return false
        }
    }
}